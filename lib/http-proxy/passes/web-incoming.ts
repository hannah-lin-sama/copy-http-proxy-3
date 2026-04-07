/*
A `pass` is just a function that is executed on `req, res, options`
so that you can easily add new checks while still keeping the base
flexible.

The names of passes are exported as WEB_PASSES from this module.

*/

import type { IncomingMessage as Request, ServerResponse as Response } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import type Stream from "node:stream";
import * as followRedirects from "follow-redirects";
import type {
  ErrorCallback,
  FetchOptions,
  NormalizedServerOptions,
  NormalizeProxyTarget,
  ProxyServer,
  ProxyTarget,
  ProxyTargetUrl,
  ServerOptions,
} from "..";
import * as common from "../common";
import { type EditableResponse, OUTGOING_PASSES } from "./web-outgoing";
import { Readable } from "node:stream";

export type ProxyResponse = Request & {
  headers: { [key: string]: string | string[] };
};
export type { Request, Response };

const web_o = Object.values(OUTGOING_PASSES);

const nativeAgents = { http, https };

//  Sets `content-length` to '0' if request is of DELETE type.
/**
 * 处理 HTTP DELETE 和 OPTIONS 请求的请求头
 * @param req 
 */
export function deleteLength(req: Request) {
  // 当请求方法为 DELETE 或 OPTIONS
  // 且请求头中没有 content-length 字段
  if ((req.method === "DELETE" || req.method === "OPTIONS") && !req.headers["content-length"]) {
    // 设置明确表示请求体长度为 0
    // 根据 HTTP 规范，DELETE 请求可以包含请求体，但通常不需要
    req.headers["content-length"] = "0";
    // 删除 transfer-encoding 头
    // transfer-encoding 表示指定传输编码方式
    // Content-Length vs Transfer-Encoding 两者不应同时存在
    delete req.headers["transfer-encoding"];
  }
}

// Sets timeout in request socket if it was specified in options.
/**
 * 设置请求的超时时间
 * @param req 
 * @param _res 
 * @param options 
 */
export function timeout(req: Request, _res: Response, options: ServerOptions) {
  if (options.timeout) {
    // 设置套接字超时,单位毫秒
    // 超时时间通常设置为合理的值，如 30 秒或 60 秒
    req.socket.setTimeout(options.timeout);
  }
}

// Sets `x-forwarded-*` headers if specified in config.
/**
 * 用于在 HTTP 代理请求中自动添加 X-Forwarded-* 标准头部，
 * 以便后端服务器能够获取原始客户端的真实信息（如 IP 地址、端口、协议和主机名）
 * @param req 
 * @param _res 
 * @param options 
 * @returns 
 */
export function XHeaders(req: Request, _res: Response, options: ServerOptions) {
   // 未开启转发，直接返回
  if (!options.xfwd) {
    return;
  }
  // 检测原始请求是否通过 TLS 加密
  const encrypted = common.hasEncryptedConnection(req);
  // 构建包含原始请求信息的对象
  const values = {
    // 原始客户端的 IP 地址（
    for: req.connection.remoteAddress || req.socket.remoteAddress,
    port: common.getPort(req), // 提取原始请求的目标端口
    // 原始请求使用的协议（http 或 https）
    proto: encrypted ? "https" : "http",
  };

  // 添加/修改 X-Forwarded-For、X-Forwarded-Port、X-Forwarded-Proto 头
  for (const header of ["for", "port", "proto"] as const) {
    req.headers["x-forwarded-" + header] =
      (req.headers["x-forwarded-" + header] || "") 
      + (req.headers["x-forwarded-" + header] ? "," : "") 
      + values[header];
  }

  // 设置 X-Forwarded-Host（优先取 :authority，其次 host）
  req.headers["x-forwarded-host"] = 
    req.headers["x-forwarded-host"] || 
    req.headers[":authority"] || 
    req.headers["host"] || "";
}

// Does the actual proxying. If `forward` is enabled fires up
// a ForwardStream (there is NO RESPONSE), same happens for ProxyStream. The request
// just dies otherwise.
/**
 * 负责处理 HTTP 请求的代理转发。
 * 它支持正向代理和反向代理模式，能够处理各种边缘情况，并通过事件系统提供丰富的扩展点
 * @param req 客户端的原始 HTTP 请求对象
 * @param res 客户端的 HTTP 响应对象（用于返回代理结果）
 * @param options 规范化后的代理配置（包含 target、forward、xfwd、selfHandleResponse 等
 * @param _ 可选的请求体缓冲（Buffer），当有预读数据时传入
 * @param server ProxyServer 实例，用于触发事
 * @param cb 回调函数
 * @returns 
 */
export function stream(
  req: Request,
  res: Response,
  options: NormalizedServerOptions,
  _: Buffer | undefined,
  server: ProxyServer,
  cb: ErrorCallback | undefined,
) {
  // And we begin!
  // 发送 "start" 事件，通知监听器代理过程开始
  server.emit("start", req, res, options.target || options.forward!);

  if (options.fetch ||options.fetchOptions || process.env.FORCE_FETCH_PATH === "true") {
    // 1、基于 fetch API
    return stream2(req, res, options, _, server, cb);
  }

  // 2、使用传统的 HTTP 客户端方式

  const agents = options.followRedirects ? followRedirects : nativeAgents;
  const http = agents.http as typeof import("http");
  const https = agents.https as typeof import("https");

  // 2-1正向代理处理
  if (options.forward) {
    // forward enabled, so just pipe the request
    // 根据目标协议选择 HTTP 或 HTTPS 客户端
    const proto = options.forward.protocol === "https:" ? https : http;
    // 设置出站请求选项
    const outgoingOptions = common.setupOutgoing(options.ssl || {}, options, req, "forward");

    // 创建客户端请求
    const forwardReq = proto.request(outgoingOptions);

    // error handler (e.g. ECONNRESET, ECONNREFUSED)
    // Handle errors on incoming request as well as it makes sense to
    // 创建错误处理函数
    const forwardError = createErrorHandler(forwardReq, options.forward);
    req.on("error", forwardError);
    forwardReq.on("error", forwardError);

    // 管道传输请求数据
    (options.buffer || req).pipe(forwardReq);

    // 如果没有配置 target（即最终目标服务器），则正向代理完成后直接结束客户端响应（不返回任何内容），
    // 因为请求已经被完全转发，且没有后续的目标需要处理
    if (!options.target) {
      // no target, so we do not send anything back to the client.
      // If target is set, we do a separate proxy below, which might be to a
      // completely different server.
      return res.end();
    }
  }

  // 2-2反向代理处理
  // Request initalization
  const proto = options.target!.protocol === "https:" ? https : http;
  // 设置出站请求选项
  const outgoingOptions = common.setupOutgoing(options.ssl || {}, options, req);
  const proxyReq = proto.request(outgoingOptions); // 创建客户端请求

  // Enable developers to modify the proxyReq before headers are sent
  proxyReq.on("socket", (socket: Socket) => {
    if (server && !proxyReq.getHeader("expect")) {
      server.emit("proxyReq", proxyReq, req, res, options, socket);
    }
  });

  // allow outgoing socket to timeout so that we could
  // show an error page at the initial request
  if (options.proxyTimeout) {
    proxyReq.setTimeout(options.proxyTimeout, () => {
      proxyReq.destroy();
    });
  }

  // Ensure we abort proxy if request is aborted
  res.on("close", () => {
    const aborted = !res.writableFinished;
    if (aborted) {
      proxyReq.destroy();
    }
  });

  // handle errors in proxy and incoming request, just like for forward proxy
  const proxyError = createErrorHandler(proxyReq, options.target!);
  req.on("error", proxyError);
  proxyReq.on("error", proxyError);

  function createErrorHandler(proxyReq: http.ClientRequest, url: NormalizeProxyTarget<ProxyTargetUrl>) {
    return (err: Error) => {
      if (req.socket.destroyed && (err as NodeJS.ErrnoException).code === "ECONNRESET") {
        server.emit("econnreset", err, req, res, url);
        proxyReq.destroy();
        return;
      }

      if (cb) {
        cb(err, req, res, url);
      } else {
        server.emit("error", err, req, res, url);
      }
    };
  }

  // 将请求数据（或缓冲区）管道传输到代理请求
  (options.buffer || req).pipe(proxyReq);

  // 响应处理
  // 主要职责是将后端服务器的响应转发给客户端
  proxyReq.on("response", (proxyRes: ProxyResponse) => {
    // 向外部（即 ProxyServer 实例的监听器）发出 proxyRes 事件，传递代理响应对象、原始客户端请求和响应对象
    server?.emit("proxyRes", proxyRes, req, res);

    // 检查是否已经向客户端发送了响应头。如果尚未发送，才允许 passes 修改头部
    // 如果用户设置 selfHandleResponse: true，表示代理不自动处理响应，而是由用户自己负责
    if (!res.headersSent && !options.selfHandleResponse) {
      for (const pass of web_o) {
        // note: none of these return anything
        pass(
          req,
          res as EditableResponse,
          proxyRes,
          options as NormalizedServerOptions & {
            target: NormalizeProxyTarget<ProxyTarget>;
          },
        );
      }
    }

    // 客户端响应未完成，继续监听代理响应完成事件
    if (!res.finished) {
      // Allow us to listen for when the proxy has completed
      proxyRes.on("end", () => {
        // 当代理响应流结束时，触发自定义的 end 事件，通知外部代理完成
        server?.emit("end", req, res, proxyRes);
      });
      // We pipe to the response unless its expected to be handled by the user
      if (!options.selfHandleResponse) {
        // 将代理响应的数据流（响应体）直接传输给客户端响应流。这是流式转发，高效且内存友好
        proxyRes.pipe(res);
      }

      // 客户端响应已完成，触发 end 事件
    } else {
      server?.emit("end", req, res, proxyRes);
    }
  });
}

/**
 * 是一个基于 Fetch API 的 HTTP 代理实现函数，用于处理 HTTP 请求的代理转发
 * @param req 
 * @param res 
 * @param options 
 * @param _ 
 * @param server 
 * @param cb 
 * @returns 
 */
async function stream2(
  req: Request,
  res: Response,
  options: NormalizedServerOptions,
  _: Buffer | undefined,
  server: ProxyServer,
  cb?: ErrorCallback,
) {
  // Helper function to handle errors consistently throughout the fetch path
  const handleError = (err: Error, target?: ProxyTargetUrl) => {
    const e = err as any;
    // Copy code from cause if available and missing on err
    if (e.code === undefined && e.cause?.code) {
      e.code = e.cause.code;
    }

    // 优先使用回调
    if (cb) {
      cb(err, req, res, target);

      // 事件触发
    } else {
      server.emit("error", err, req, res, target);
    }
  };

  // 捕获客户端请求流中发生的错误（如网络中断、解析错误等）
  // req 是客户端发起的 HTTP 请求对象（http.IncomingMessage），它是一个可读流
  req.on("error", (err: Error) => {

    if (
       // 检查底层的 socket 是否已经被销毁
      //  当客户端主动断开连接（如关闭浏览器标签页、网络中断）时，socket.destroyed 通常为 true
      req.socket.destroyed && 
      // 错误码 ECONNRESET 表示“连接被对方重置”，
      // 这通常发生在客户端已经关闭连接，但服务器仍在尝试读取或写入数据时
      (err as NodeJS.ErrnoException).code === "ECONNRESET"
    ) {
      // 获取目标地址并触发 econnreset 事件
      const target = options.target || options.forward;
      if (target) {
        server.emit("econnreset", err, req, res, target);
      }
      return;
    }
    handleError(err);
  });

  // fetch配置
  // 自定义 fetch 函数，用于发起 HTTP 请求
  // 如果用户没有提供自定义的 fetch 函数，默认使用全局的 fetch 函数
  const customFetch = options.fetch || fetch;
  const fetchOptions = options.fetchOptions ?? {} as FetchOptions;

  /**
   * 负责将传统 Node.js 的 http.ClientRequest 风格的请求参数（outgoing 对象）转换为现代 fetch API 所需的 RequestInit 配置对象
   * @param outgoing 
   * @returns 
   */
  const prepareRequest = (outgoing: common.Outgoing) => {
    const requestOptions: RequestInit = {
      method: outgoing.method,
      ...fetchOptions.requestOptions,
    };

    // 创建 Headers 对象
    const headers = new Headers(fetchOptions.requestOptions?.headers);

    if (!fetchOptions.requestOptions?.headers && outgoing.headers) {
      // 遍历 outgoing.headers 中的每个键值对
      for (const [key, value] of Object.entries(outgoing.headers)) {
        if (typeof key === "string") {
          if (Array.isArray(value)) {
            for (const v of value) {
              headers.append(key, v as string);
            }
          } else if (value != null) {
            headers.append(key, value as string);
          }
        }
      }
    }

    // 添加基本认证（Basic Auth）
    if (options.auth) {
      // 自动生成 Authorization: Basic <base64> 头，添加到请求中
      headers.set("authorization", `Basic ${Buffer.from(options.auth).toString("base64")}`);
    }

    // 设置超时信号
    if (options.proxyTimeout) {
      // 创建一个 AbortSignal，超时后会自动中止 fetch 请求
      requestOptions.signal = AbortSignal.timeout(options.proxyTimeout);
    }

    requestOptions.headers = headers;

    // 设置请求体
    if (options.buffer) {
      // 如果存在预读的请求体缓冲区（通常用于已经读取了一部分请求体的情况），则直接将其作为 body
      requestOptions.body = options.buffer as Stream.Readable;

      // 对于非 GET/HEAD 请求
    } else if (req.method !== "GET" && req.method !== "HEAD") {
      // 将原始的客户端请求流 req 作为 body。同时设置 duplex: "half"
      requestOptions.body = req;
      requestOptions.duplex = "half";
    }

    return requestOptions;
  };

  // 正向代理
  if (options.forward) {
    const outgoingOptions = common.setupOutgoing(options.ssl || {}, options, req, "forward");
    const requestOptions = prepareRequest(outgoingOptions);
    let targetUrl = new URL(outgoingOptions.url).origin + outgoingOptions.path;
    if (targetUrl.startsWith("ws")) {
      targetUrl = targetUrl.replace("ws", "http");
    }

    // Call onBeforeRequest callback before making the forward request
    if (fetchOptions.onBeforeRequest) {
      try {
        await fetchOptions.onBeforeRequest(requestOptions, req, res, options);
      } catch (err) {
        handleError(err as Error, options.forward);
        return;
      }
    }

    try {
      const result = await customFetch(targetUrl, requestOptions);

      // Call onAfterResponse callback for forward requests (though they typically don't expect responses)
      if (fetchOptions.onAfterResponse) {
        try {
          await fetchOptions.onAfterResponse(result, req, res, options);
        } catch (err) {
          handleError(err as Error, options.forward);
          return;
        }
      }
    } catch (err) {
      handleError(err as Error, options.forward);
    }

    if (!options.target) {
      return res.end();
    }
  }

  // 反向代理
  // 将客户端的请求发送给正向代理，而不是直接连接到目标服务器
  // 构造出站请求选项
  const outgoingOptions = common.setupOutgoing(options.ssl || {}, options, req);
  // 转换为 fetch 请求选项
  const requestOptions = prepareRequest(outgoingOptions);
  // 构建目标 URL
  let targetUrl = new URL(outgoingOptions.url).origin + outgoingOptions.path;
  // WebSocket 协议转换
  if (targetUrl.startsWith("ws")) {
    targetUrl = targetUrl.replace("ws", "http");
  }

  // Call onBeforeRequest callback before making the request
  // 请求前钩子
  if (fetchOptions.onBeforeRequest) {
    try {
      await fetchOptions.onBeforeRequest(requestOptions, req, res, options);
    } catch (err) {
      handleError(err as Error, options.target);
      return;
    }
  }

  try {
    // 发起 fetch 请求
    const response = await customFetch(targetUrl, requestOptions);

    // Call onAfterResponse callback after receiving the response
    // 响应后钩子
    if (fetchOptions.onAfterResponse) {
      try {
        await fetchOptions.onAfterResponse(response, req, res, options);
      } catch (err) {
        handleError(err as Error, options.target);
        return;
      }
    }

    // ProxyRes is used in the outgoing passes
    // But since only certain properties are used, we can fake it here
    // to avoid having to refactor everything.
    // 模拟 ProxyResponse 对象
    const fakeProxyRes = {
      statusCode: response.status,
      statusMessage: response.statusText,
      // 将 Headers 对象转换为普通对象
      headers: Object.fromEntries(response.headers.entries()),
      rawHeaders: Object.entries(response.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) {
          return value.flatMap((v) => (v != null ? [key, v] : []));
        }
        return value != null ? [key, value] : [];
      }) as string[],
    } as unknown as ProxyResponse;

    // 触发 proxyRes 事件，通知代理服务器响应已接收
    server?.emit("proxyRes", fakeProxyRes, req, res);

    // 执行后处理 passes
    if (!res.headersSent && !options.selfHandleResponse) {
      for (const pass of web_o) {
        // note: none of these return anything
        pass(
          req,
          res as EditableResponse,
          fakeProxyRes,
          options as NormalizedServerOptions & {
            target: NormalizeProxyTarget<ProxyTarget>;
          },
        );
      }
    }

    // 处理响应体流
    // 检查客户端响应是否已结束
    if (!res.writableEnded) {
      // Allow us to listen for when the proxy has completed
      // 创建可读流
      const nodeStream = response.body ? Readable.from(response.body as AsyncIterable<Uint8Array>) : null;

      if (nodeStream) {
        nodeStream.on("error", (err) => {
          handleError(err, options.target);
        });

        nodeStream.on("end", () => {
          server?.emit("end", req, res, fakeProxyRes);
        });

        // We pipe to the response unless its expected to be handled by the user
        if (!options.selfHandleResponse) {
          // 将流 pipe 到客户端响应 res（并结束响应）
          nodeStream.pipe(res, { end: true });
        } else {
          // 仅恢复流（不发送数据），由用户自行处理
          nodeStream.resume();
        }
      } else {
        server?.emit("end", req, res, fakeProxyRes);
      }
    } else {
      server?.emit("end", req, res, fakeProxyRes);
    }
  } catch (err) {
    handleError(err as Error, options.target);
  }
}

export const WEB_PASSES = { deleteLength, timeout, XHeaders, stream };
