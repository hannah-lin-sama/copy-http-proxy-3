/*
Websockets Passes: Array of passes.

A `pass` is just a function that is executed on `req, socket, options`
so that you can easily add new checks while still keeping the base
flexible.

The names of passes are exported as WS_PASSES from this module.
*/

import * as http from "node:http";
import * as https from "node:https";
import * as common from "../common";
import type { Request, ProxyResponse } from "./web-incoming";
import { OUTGOING_PASSES, EditableResponse } from "./web-outgoing";
import type { Socket } from "node:net";
import debug from "debug";
import type { NormalizedServerOptions, NormalizeProxyTarget, ProxyServer, ProxyTarget } from "..";

const log = debug("http-proxy-3:ws-incoming");
const web_o = Object.values(OUTGOING_PASSES);

/**
 * 创建一个 WebSocket 连接计数器函数
 * @param name 计数器的名称，用于日志记录
 * @returns 计数器函数
 */
function createSocketCounter(name: string) {
  let sockets = new Set<number>();
  return ({
    add,
    rm,
  }: {
    add?: Socket & { id?: number };
    rm?: Socket & { id?: number };
  } = {}) => {
    // 添加 socket
    if (add) {
      if (!add.id) {
        add.id = Math.random();
      }
      if (!sockets.has(add.id)) {
        sockets.add(add.id);
      }
    }
    // 移除 socket
    if (rm) {
      if (!rm.id) {
        rm.id = Math.random();
      }
      if (sockets.has(rm.id)) {
        sockets.delete(rm.id);
      }
    }
    log(
      "socket counter:",
      { [name]: sockets.size },
      add ? "add" : rm ? "rm" : "",
    );
    return sockets.size;
  };
}

const socketCounter = createSocketCounter("socket");
const proxySocketCounter = createSocketCounter("proxySocket");

/* MockResponse
   when a websocket gets a regular HTTP Response,
   apply proxied headers
*/
class MockResponse implements EditableResponse {
  constructor() {
    this.headers = {};
    this.statusCode = 200
    this.statusMessage = "";
  }
  public headers: { [key: string]: string};
  public statusCode: number;
  public statusMessage: string;
  
  setHeader(key: string, value: string)  {
    this.headers[key] = value;
    return this;
  };
}

/**
 * 是统计当前打开的 WebSocket 连接总数，包括客户端 socket 和代理服务器 socket
 * @returns 总的打开连接数
 */
export function numOpenSockets(): number {
  // 调用 socketCounter() 获取当前客户端 socket 数量
  // 调用 proxySocketCounter() 获取当前代理服务器 socket 数量
  return socketCounter() + proxySocketCounter();
}

// WebSocket requests must have the `GET` method and
// the `upgrade:websocket` header
/**
 * 验证 WebSocket 连接请求的合法性
 * @param req 
 * @param socket 
 * @returns 
 */
export function checkMethodAndHeader(
  req: Request,
  socket: Socket,
): true | undefined {
  log("websocket: checkMethodAndHeader");
  // 请求方法非get或没有upgrade头
  if (req.method !== "GET" || !req.headers.upgrade) {
    socket.destroy();
    return true;
  }

  // upgrade头非websocket
  if (req.headers.upgrade.toLowerCase() !== "websocket") {
    socket.destroy();
    return true;
  }
}

// Sets `x-forwarded-*` headers if specified in config.
/**
 * 设置 WebSocket 请求的 `x-forwarded-*` 头
 * @param req WebSocket 请求对象
 * @param _socket 未使用的 socket 对象
 * @param options 代理服务器选项
 */
export function XHeaders(req: Request, _socket: Socket, options: NormalizedServerOptions) {
  if (!options.xfwd) return;
  log("websocket: XHeaders");

  const values = {
    // 获取原始客户端 IP 地址
    for: req.connection.remoteAddress || req.socket.remoteAddress,
    port: common.getPort(req), // 获取原始请求端口
    // 根据连接是否加密确定 WebSocket 协议（加密为 "wss"，非加密为 "ws"）
    proto: common.hasEncryptedConnection(req) ? "wss" : "ws",
  };

  // 添加/修改 X-Forwarded-* 头
  for (const header of ["for", "port", "proto"] as const) {
    req.headers["x-forwarded-" + header] =
      (req.headers["x-forwarded-" + header] || "") +
      (req.headers["x-forwarded-" + header] ? "," : "") +
      values[header];
  }
}

// Do the actual proxying. Make the request and upgrade it.
// Send the Switching Protocols request and pipe the sockets.
/**
 * 负责建立和管理 WebSocket 连接的代理转发。
 * 它处理从客户端到目标服务器的 WebSocket 连接，包括连接建立、数据传输和错误处理等完整流程
 * @param req  // 客户端 HTTP 请求对象（包含 Upgrade 头）
 * @param socket // 底层 TCP socket（已建立连接）
 * @param options // 代理配置（含 target、forward、ws 等）
 * @param head 
 * @param server  // ProxyServer 实例，用于触发事件
 * @param cb 
 */
export function stream(
  req: Request,
  socket: Socket,
  options: NormalizedServerOptions,
  head: Buffer | undefined,
  server: ProxyServer,
  cb?: Function,
) {
  log("websocket: new stream");
  // 代理端socket
  const proxySockets: Socket[] = [];
  // 计数客户端socket
  socketCounter({ add: socket });
  // 清理代理端socket
  const cleanUpProxySockets = () => {
    for (const p of proxySockets) {
      p.end();
    }
  };
  // 当客户端socket关闭时，清理代理端socket
  socket.on("close", () => {
    socketCounter({ rm: socket });
    cleanUpProxySockets();
  });

  // The pipe below will end proxySocket if socket closes cleanly, but not
  // if it errors (eg, vanishes from the net and starts returning
  // EHOSTUNREACH). We need to do that explicitly.
  socket.on("error", cleanUpProxySockets);

  // 构造 HTTP 响应头
  const createHttpHeader = (line: string, headers: http.IncomingHttpHeaders) => {
    return (
      Object.keys(headers)
        .reduce(
          (head, key) => {
            const value = headers[key];

            if (!Array.isArray(value)) {
              head.push(key + ": " + value);
              return head;
            }

            for (let i = 0; i < value.length; i++) {
              head.push(key + ": " + value[i]);
            }
            return head;
          },
          [line],
        )
        .join("\r\n") + "\r\n\r\n"
    );
  };

  common.setupSocket(socket);

  if (head && head.length) {
    socket.unshift(head);
  }

  // @ts-expect-error FIXME: options.target may be undefined
  // 选择协议模块
  const proto = common.isSSL.test(options.target.protocol) ? https : http;
  // 构造请求选项 
  const outgoingOptions = common.setupOutgoing(options.ssl || {}, options, req);
  // 发送请求
  const proxyReq = proto.request(outgoingOptions);

  // Enable developers to modify the proxyReq before headers are sent
  // 触发 proxyReqWs 事件
  // 允许开发人员在发送请求前修改请求对象
  if (server) {
    server.emit("proxyReqWs", proxyReq, req, socket, options, head);
  }

  // Error Handler
  proxyReq.on("error", onOutgoingError);

  // 处理目标服务器的 upgrade 事件（成功升级）
  proxyReq.on(
    "upgrade",
    (proxyRes: Request, proxySocket: Socket, proxyHead: Buffer) => {
      log("upgrade");

      proxySocketCounter({ add: proxySocket });
      proxySockets.push(proxySocket);
      proxySocket.on("close", () => {
        proxySocketCounter({ rm: proxySocket });
      });

      proxySocket.on("error", onOutgoingError);

      // Allow us to listen for when the websocket has completed.
      proxySocket.on("end", () => {
        server.emit("close", proxyRes, proxySocket, proxyHead);
      });

      proxySocket.on("close", () => {
        socket.end();
      });

      common.setupSocket(proxySocket);

      if (proxyHead && proxyHead.length) {
        proxySocket.unshift(proxyHead);
      }

      // Remark: Handle writing the headers to the socket when switching protocols
      // Also handles when a header is an array.
      socket.write(
        createHttpHeader("HTTP/1.1 101 Switching Protocols", proxyRes.headers),
      );

      proxySocket.pipe(socket).pipe(proxySocket);

      server.emit("open", proxySocket);
    },
  );

  function onOutgoingError(err: Error) {
    if (cb) {
      cb(err, req, socket);
    } else {
      server.emit("error", err, req, socket);
    }
    // I changed this from "socket.end()" which is what node-http-proxy does to destroySoon() due to getting
    // the unit test "should close client socket if upstream is closed before upgrade" from lib/http-proxy.test.ts
    // to work.  Just doing socket.end() leaves things half open for a while if proxySocket errors out,
    // which may be another leak type situation and definitely doesn't work for unit testing.
    socket.destroySoon();
  }

  // if we get a response, backend is not a websocket endpoint,
  // relay HTTP response and close the socket
  // 处理目标服务器的 response 事件（后端不支持 WebSocket）
  proxyReq.on("response", (proxyRes: ProxyResponse) => {
    log("got non-ws HTTP response",
        {
          statusCode: proxyRes.statusCode,
          statusMessage: proxyRes.statusMessage,
        }
    );

    const res = new MockResponse();
    for (const pass of web_o) {
      // note: none of these return anything
      pass(req, res as EditableResponse, proxyRes, options as NormalizedServerOptions & { target: NormalizeProxyTarget<ProxyTarget> });
    }

    // implement HTTP/1.1 chunked transfer unless content-length is defined
    // matches proxyRes.pipe(res) behavior,
    // but we are piping directly to the socket instead, so it's our job.
    let writeChunk = (chunk: Buffer | string) => {
      socket.write(chunk);
    }
    if (req.httpVersion === "1.1" && proxyRes.headers["content-length"] === undefined) {
      res.headers["transfer-encoding"] = "chunked";
      writeChunk = (chunk: Buffer | string) => {
        socket.write(chunk.length.toString(16));
        socket.write("\r\n");
        socket.write(chunk);
        socket.write("\r\n");
      }
    }

    const proxyHead = createHttpHeader(
      `HTTP/${req.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
      res.headers,
    );
    if (!socket.destroyed) {
      socket.write(proxyHead);
      proxyRes.on("data", (chunk) => {
        writeChunk(chunk);
      })
      proxyRes.on("end", () => {
        writeChunk("");
        socket.destroySoon();
      })
    } else {
      // make sure response is consumed
      proxyRes.resume();
    }
  });

  proxyReq.end();
}

export const WS_PASSES = { checkMethodAndHeader, XHeaders, stream };
