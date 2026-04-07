import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import { WEB_PASSES } from "./passes/web-incoming";
import { WS_PASSES } from "./passes/ws-incoming";
import { EventEmitter } from "node:events";
import type { Stream } from "node:stream";
import debug from "debug";
import { toURL } from "./common";

const log = debug("http-proxy-3");

export interface ProxyTargetDetailed {
  host: string;
  port: number;
  protocol?: string;
  hostname?: string;
  socketPath?: string;
  key?: string;
  passphrase?: string;
  pfx?: Buffer | string;
  cert?: string;
  ca?: string;
  ciphers?: string;
  secureProtocol?: string;
}
export type ProxyType = "ws" | "web";
export type ProxyTarget = ProxyTargetUrl | ProxyTargetDetailed;
export type ProxyTargetUrl =
  | URL
  | string
  | { port: number; host: string; protocol?: string };

export type NormalizeProxyTarget<T extends ProxyTargetUrl> =
  | Exclude<T, string>
  | URL;

export interface ServerOptions {
  // NOTE: `options.target and `options.forward` cannot be both missing when the
  // actually proxying is called.  However, they can be missing when creating the
  // proxy server in the first place!  E.g., you could make a proxy server P with
  // no options, then use P.web(req,res, {target:...}).
  /** URL string to be parsed with the url module. */
  // 最终目标服务器 URL,代理请求将被转发到此地址
  target?: ProxyTarget;
  /** URL string to be parsed with the url module or a URL object. */
  // 上游正向代理服务器 URL。若指定，请求会先发给 forward，再由其转发到 target
  forward?: ProxyTargetUrl;
  /** Object to be passed to http(s).request. */
  // 自定义 HTTP/HTTPS 代理的 Agent 实例，用于控制连接池、代理认证等
  agent?: any;
  /** Object to be passed to https.createServer(). */
  // 当创建 HTTPS 服务器时，传入的 TLS 选项
  ssl?: any;
  /** If you want to proxy websockets. */
  // 是否代理 WebSocket 连接
  ws?: boolean;
  /** Adds x- forward headers. */
  // 是否添加 X-Forwarded-For、X-Forwarded-Port、X-Forwarded-Proto 等头部，用于向后端传递原始客户端信息
  xfwd?: boolean;
  /** Verify SSL certificate. */
  // 是否验证 SSL 证书
  secure?: boolean;
  /** Explicitly specify if we are proxying to another proxy. */
  // 是否将当前代理视为另一个代理的下游。用于链式代理场景，会影响请求路径的处理
  toProxy?: boolean;
  /** Specify whether you want to prepend the target's path to the proxy path. */
  // 是否将 target 的路径前缀添加到代理请求路径前
  prependPath?: boolean;
  /** Specify whether you want to ignore the proxy path of the incoming request. */
  // 是否忽略代理路径
  ignorePath?: boolean;
  /** Local interface string to bind for outgoing connections. */
  // 本地网络接口的 IP 地址，用于绑定出站连接的源地址
  localAddress?: string;
  /** Changes the origin of the host header to the target URL. */
  // 是否将请求头中的 Host 改为 target 的主机名。解决后端根据 Host 做虚拟主机路由时的跨域问题
  changeOrigin?: boolean;
  /** specify whether you want to keep letter case of response header key */
  preserveHeaderKeyCase?: boolean;
  /** Basic authentication i.e. 'user:password' to compute an Authorization header. */
  // 基本认证凭证（'user:password'），会自动生成 Authorization 头
  auth?: string;
  /** Rewrites the location hostname on (301 / 302 / 307 / 308) redirects, Default: null. */
  // 重写重定向响应中的 Location 头的主机名部分
  hostRewrite?: string;
  /** Rewrites the location host/ port on (301 / 302 / 307 / 308) redirects based on requested host/ port.Default: false. */
  // 是否根据原始请求的主机和端口自动重写重定向的 Location 头
  autoRewrite?: boolean;
  /** Rewrites the location protocol on (301 / 302 / 307 / 308) redirects to 'http' or 'https'.Default: null. */
  // 强制将重定向中的协议重写为 'http' 或 'https'
  protocolRewrite?: string;
  /** rewrites domain of set-cookie headers. */
  // 重写 Set-Cookie 头中的 Domain 属性。可设为固定字符串或映射对象
  cookieDomainRewrite?: false | string | { [oldDomain: string]: string };
  /** rewrites path of set-cookie headers. Default: false */
  // 重写 Set-Cookie 头中的 Path 属性
  cookiePathRewrite?: false | string | { [oldPath: string]: string };
  /** object with extra headers to be added to target requests. */
  headers?: { [header: string]: string | string[] | undefined };
  /** Timeout (in milliseconds) when proxy receives no response from target. Default: 120000 (2 minutes) */
  // 代理请求超时（毫秒），超过此时间未收到目标服务器响应则断开连接
  proxyTimeout?: number;
  /** Timeout (in milliseconds) for incoming requests */
  // 客户端请求超时（毫秒），影响 req 的 timeout 事件
  timeout?: number;
  /** Specify whether you want to follow redirects. Default: false */
  // 是否自动跟随目标服务器返回的 3xx 重定向
  followRedirects?: boolean;
  /** If set to true, none of the webOutgoing passes are called and it's your responsibility to appropriately return the response by listening and acting on the proxyRes event */
  // 若为 true，代理不会自动将响应体返回给客户端，需用户通过监听 proxyRes 事件自行处理
  selfHandleResponse?: boolean;
  /** Buffer */
  // 预读的请求体流，用于在代理开始前已经读取了部分数据的情况
  buffer?: Stream;
  /** Explicitly set the method type of the ProxyReq */
  // 强制指定代理请求的 HTTP 方法
  method?: string;
  /**
   * Optionally override the trusted CA certificates.
   * This is passed to https.request.
   * 覆盖受信任的 CA 证书，用于自定义证书校验
   */
  ca?: string;
  /** Optional fetch implementation to use instead of global fetch, use this to activate fetch-based proxying,
   * for example to proxy HTTP/2 requests
   * 可选的自定义 fetch 实现，用于启用基于 Fetch API 的代理（支持 HTTP/2 等）
  */
 fetch?: typeof fetch;
  /** Optional configuration object for fetch-based proxy requests. 
   * Use this to customize fetch request and response handling. 
   * For custom fetch implementations, use the `fetch` property.*/
  // 配合 fetch 使用的额外选项，如请求重试、超时等
 fetchOptions?: FetchOptions;
}
export interface FetchOptions {
  /** Fetch request options */
  requestOptions?: RequestInit;
  /** Called before making the fetch request */
  onBeforeRequest?: (
    requestOptions: RequestInit,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options: NormalizedServerOptions,
  ) => void | Promise<void>;
  /** Called after receiving the fetch response */
  onAfterResponse?: (
    response: Response,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options: NormalizedServerOptions,
  ) => void | Promise<void>;
}

export interface NormalizedServerOptions extends ServerOptions {
  target?: NormalizeProxyTarget<ProxyTarget>;
  forward?: NormalizeProxyTarget<ProxyTargetUrl>;
}

export type ErrorCallback<
  TIncomingMessage extends
    typeof http.IncomingMessage = typeof http.IncomingMessage,
  TServerResponse extends
    typeof http.ServerResponse = typeof http.ServerResponse,
  TError = Error,
> = (
  err: TError,
  req: InstanceType<TIncomingMessage>,
  res: InstanceType<TServerResponse> | net.Socket,
  target?: ProxyTargetUrl,
) => void;

type ProxyServerEventMap<
  TIncomingMessage extends
    typeof http.IncomingMessage = typeof http.IncomingMessage,
  TServerResponse extends
    typeof http.ServerResponse = typeof http.ServerResponse,
  TError = Error,
> = {
  error: Parameters<ErrorCallback<TIncomingMessage, TServerResponse, TError>>;
  start: [
    req: InstanceType<TIncomingMessage>,
    res: InstanceType<TServerResponse>,
    target: ProxyTargetUrl,
  ];
  open: [socket: net.Socket];
  proxyReq: [
    proxyReq: http.ClientRequest,
    req: InstanceType<TIncomingMessage>,
    res: InstanceType<TServerResponse>,
    options: ServerOptions,
    socket: net.Socket,
  ];
  proxyRes: [
    proxyRes: InstanceType<TIncomingMessage>,
    req: InstanceType<TIncomingMessage>,
    res: InstanceType<TServerResponse>,
  ];
  proxyReqWs: [
    proxyReq: http.ClientRequest,
    req: InstanceType<TIncomingMessage>,
    socket: net.Socket,
    options: ServerOptions,
    head: any,
  ];
  econnreset: [
    err: Error,
    req: InstanceType<TIncomingMessage>,
    res: InstanceType<TServerResponse>,
    target: ProxyTargetUrl,
  ];
  end: [
    req: InstanceType<TIncomingMessage>,
    res: InstanceType<TServerResponse>,
    proxyRes: InstanceType<TIncomingMessage>,
  ];
  close: [
    proxyRes: InstanceType<TIncomingMessage>,
    proxySocket: net.Socket,
    proxyHead: any,
  ];
};

type ProxyMethodArgs<
  TIncomingMessage extends
    typeof http.IncomingMessage = typeof http.IncomingMessage,
  TServerResponse extends
    typeof http.ServerResponse = typeof http.ServerResponse,
  TError = Error,
> = {
  ws: [
    req: InstanceType<TIncomingMessage>,
    socket: any,
    head: any,
    ...args:
      | [
          options?: ServerOptions,
          callback?: ErrorCallback<TIncomingMessage, TServerResponse, TError>,
        ]
      | [callback?: ErrorCallback<TIncomingMessage, TServerResponse, TError>],
  ];
  web: [
    req: InstanceType<TIncomingMessage>,
    res: InstanceType<TServerResponse>,
    ...args:
      | [
          options: ServerOptions,
          callback?: ErrorCallback<TIncomingMessage, TServerResponse, TError>,
        ]
      | [callback?: ErrorCallback<TIncomingMessage, TServerResponse, TError>],
  ];
};

type PassFunctions<
  TIncomingMessage extends
    typeof http.IncomingMessage = typeof http.IncomingMessage,
  TServerResponse extends
    typeof http.ServerResponse = typeof http.ServerResponse,
  TError = Error,
> = {
  ws: (
    req: InstanceType<TIncomingMessage>,
    socket: net.Socket,
    options: NormalizedServerOptions,
    head: Buffer | undefined,
    server: ProxyServer<TIncomingMessage, TServerResponse, TError>,
    cb?: ErrorCallback<TIncomingMessage, TServerResponse, TError>,
  ) => unknown;
  web: (
    req: InstanceType<TIncomingMessage>,
    res: InstanceType<TServerResponse>,
    options: NormalizedServerOptions,
    head: Buffer | undefined,
    server: ProxyServer<TIncomingMessage, TServerResponse, TError>,
    cb?: ErrorCallback<TIncomingMessage, TServerResponse, TError>,
  ) => unknown;
};

export class ProxyServer<
  TIncomingMessage extends
    typeof http.IncomingMessage = typeof http.IncomingMessage,
  TServerResponse extends
    typeof http.ServerResponse = typeof http.ServerResponse,
  TError = Error,
> extends EventEmitter<
  ProxyServerEventMap<TIncomingMessage, TServerResponse, TError>
> {
  /**
   * Used for proxying WS(S) requests
   * @param req - Client request.
   * @param socket - Client socket.
   * @param head - Client head.
   * @param options - Additional options.
   */
  public readonly ws: (
    ...args: ProxyMethodArgs<TIncomingMessage, TServerResponse, TError>["ws"]
  ) => void;

  /**
   * Used for proxying regular HTTP(S) requests
   * @param req - Client request.
   * @param res - Client response.
   * @param options - Additional options.
   */
  public readonly web: (
    ...args: ProxyMethodArgs<TIncomingMessage, TServerResponse, TError>["web"]
  ) => void;

  private options: ServerOptions;
  private webPasses: Array<
    PassFunctions<TIncomingMessage, TServerResponse, TError>["web"]
  >;
  private wsPasses: Array<
    PassFunctions<TIncomingMessage, TServerResponse, TError>["ws"]
  >;
  private _server?:
    | http.Server<TIncomingMessage, TServerResponse>
    | http2.Http2SecureServer<TIncomingMessage, TServerResponse>
    | null;

  /**
   * Creates the proxy server with specified options.
   * @param options - Config object passed to the proxy
   */
  constructor(options: ServerOptions = {}) {
    super();
    log("creating a ProxyServer", options);
    // 是否将目标服务器的路径添加到代理路径前面
    options.prependPath = options.prependPath !== false;
    this.options = options;
    // 处理 HTTP/HTTPS 请求
    this.web = this.createRightProxy("web")(options);
    // 处理 WebSocket 连接
    this.ws = this.createRightProxy("ws")(options);

    // 处理 HTTP 请求的一系列函数
    this.webPasses = Object.values(WEB_PASSES) as Array<
      PassFunctions<TIncomingMessage, TServerResponse, TError>["web"]
    >;
    // 处理 WebSocket 连接的一系列函数
    this.wsPasses = Object.values(WS_PASSES) as Array<
      PassFunctions<TIncomingMessage, TServerResponse, TError>["ws"]
    >;
    // 监听 "error" 事件
    this.on("error", this.onError);
  }

  /**
   * Creates the proxy server with specified options.
   * @param options Config object passed to the proxy
   * @returns Proxy object with handlers for `ws` and `web` requests
   */
  static createProxyServer<
    TIncomingMessage extends typeof http.IncomingMessage,
    TServerResponse extends typeof http.ServerResponse,
    TError = Error,
  >(
    options?: ServerOptions,
  ): ProxyServer<TIncomingMessage, TServerResponse, TError> {
    return new ProxyServer<TIncomingMessage, TServerResponse, TError>(options);
  }

  /**
   * Creates the proxy server with specified options.
   * @param options Config object passed to the proxy
   * @returns Proxy object with handlers for `ws` and `web` requests
   */
  static createServer<
    TIncomingMessage extends typeof http.IncomingMessage,
    TServerResponse extends typeof http.ServerResponse,
    TError = Error,
  >(
    options?: ServerOptions,
  ): ProxyServer<TIncomingMessage, TServerResponse, TError> {
    return new ProxyServer<TIncomingMessage, TServerResponse, TError>(options);
  }

  /**
   * Creates the proxy server with specified options.
   * @param options Config object passed to the proxy
   * @returns Proxy object with handlers for `ws` and `web` requests
   */
  static createProxy<
    TIncomingMessage extends typeof http.IncomingMessage,
    TServerResponse extends typeof http.ServerResponse,
    TError = Error,
  >(
    options?: ServerOptions,
  ): ProxyServer<TIncomingMessage, TServerResponse, TError> {
    return new ProxyServer<TIncomingMessage, TServerResponse, TError>(options);
  }

  // createRightProxy - Returns a function that when called creates the loader for
  // either `ws` or `web`'s passes.
  // 用于创建处理 HTTP 或 WebSocket 代理请求的函数
  // createRightProxy 是一个三级柯里化函数
  // 第一级：接受代理类型 type（"web" 或 "ws"）
  createRightProxy = <PT extends ProxyType>(type: PT): Function => {
    log("createRightProxy", { type });
    // 第二级：接受服务器选项 options
    return (options: ServerOptions) => {
      // 第三级：接受具体的代理请求参数 args
      return (
        ...args: ProxyMethodArgs<
          TIncomingMessage,
          TServerResponse,
          TError
        >[PT] /* req, res, [head], [opts] */
      ) => {
        // 第一个参数：客户端请求 req
        const req = args[0];
        log("proxy: ", { type, path: (req as http.IncomingMessage).url });
        // 第二个参数：客户端响应 res
        const res = args[1];

        // 
        const passes = type === "ws" ? this.wsPasses : this.webPasses;

        // WebSocket 的特殊错误处理
        if (type == "ws") {
          // socket -- proxy websocket errors to our error handler;
          // see https://github.com/sagemathinc/http-proxy-3/issues/5
          // NOTE: as mentioned below, res is the socket in this case.
          // One of the passes does add an error handler, but there's no
          // guarantee we even get to that pass before something bad happens,
          // and there's no way for a user of http-proxy-3 to get ahold
          // of this res object and attach their own error handler until
          // after the passes. So we better attach one ASAP right here:
          (res as net.Socket).on("error", (err: TError) => {
            this.emit("error", err, req, res);
          });
        }
        // 最后一个参数
        let counter = args.length - 1;
        let head: Buffer | undefined;
        let cb: // 回调函数
          | ErrorCallback<TIncomingMessage, TServerResponse, TError>
          | undefined;

        // optional args parse begin
        // 识别回调函数：如果最后一个参数是函数，则作为错误回调 cb
        if (typeof args[counter] === "function") {
          cb = args[counter];
          counter--;
        }

        let requestOptions: ServerOptions;
        if (!(args[counter] instanceof Buffer) && args[counter] !== res) {
          // Copy global options, and overwrite with request options
          requestOptions = { ...options, ...args[counter] };
          counter--;
        } else {
          requestOptions = { ...options };
        }

        if (args[counter] instanceof Buffer) {
          head = args[counter];
        }

        // 将 target 和 forward 字符串转换为 URL 对象
        for (const e of ["target", "forward"] as const) {
          if (typeof requestOptions[e] === "string") {
            requestOptions[e] = toURL(requestOptions[e]);
          }
        }

        if (!requestOptions.target && !requestOptions.forward) {
          this.emit(
            "error",
            new Error("Must set target or forward") as TError,
            req,
            res,
          );
          return;
        }

        // passes 是预定义的处理阶段数组
        // WS_PASSES = { checkMethodAndHeader, XHeaders, stream }
        // WEB_PASSES = { deleteLength, timeout, XHeaders, stream }
        for (const pass of passes) {
          /**
           * Call of passes functions
           *     pass(req, res, options, head)
           *
           * In WebSockets case, the `res` variable
           * refer to the connection socket
           *    pass(req, socket, options, head)
           */
          // 如果为 true，则终止循环
          if (
            pass(
              req,
              res,
              requestOptions as NormalizedServerOptions,
              head,
              this,
              cb,
            )
          ) {
            // passes can return a truthy value to halt the loop
            break;
          }
        }
      };
    };
  };
  
  onError = (err: TError) => {
    // Force people to handle their own errors
    if (this.listeners("error").length === 1) {
      throw err;
    }
  };

  /**
   * A function that wraps the object in a webserver, for your convenience
   * 用于启动代理服务器并开始监听指定端口。
   * 它支持普通 HTTP/HTTPS 和 HTTP/2（带 SSL），同时可选地处理 WebSocket 升级
   * @param port - Port to listen on 端口号
   * @param hostname - The hostname to listen on 主机名或 IP 地址
   */
  listen = (port: number, hostname?: string) => {
    log("listen", { port, hostname });

    // 请求监听函数，将请求转发给目标服务器
    const requestListener = (
      req: InstanceType<TIncomingMessage> | http2.Http2ServerRequest,
      res: InstanceType<TServerResponse> | http2.Http2ServerResponse,
    ) => {
      this.web(
        req as InstanceType<TIncomingMessage>,
        res as InstanceType<TServerResponse>,
      );
    };

    this._server = this.options.ssl
      // 则创建 HTTP/2 安全服务器
      ? http2.createSecureServer(
        // allowHTTP1，服务器会同时兼容 HTTP/1.1 和 HTTP/2
          { ...this.options.ssl, allowHTTP1: true },
          requestListener,
        )
        // 创建普通的 HTTP/1.x 服务器（非加密）
      : http.createServer<TIncomingMessage, TServerResponse>(requestListener);

    if (this.options.ws) {
      // 监听 WebSocket 升级事件
      this._server.on(
        "upgrade",
        (req: InstanceType<TIncomingMessage>, socket, head) => {
          // 进行代理转发，将 WebSocket 升级请求转发给目标服务器
          this.ws(req, socket, head);
        },
      );
    }

    // 启动服务器
    this._server.listen(port, hostname);

    return this;
  };

  // if the proxy started its own http server, this is the address of that server.
  // 获取代理服务器绑定的网络地址信息
  address = () => {
    // 地址信息：端口号、IP 地址、协议族family
    return this._server?.address();
  };

  /**
   * A function that closes the inner webserver and stops listening on given port
   * 关闭 HTTP 代理服务器
   */
  close = (cb?: Function) => {
    // 代理服务器尚未创建或已经被关闭，直接调用回调函数
    if (this._server == null) {
      cb?.();
      return;
    }
    // Wrap cb anb nullify server after all open connections are closed.
    // 等待所有打开的连接关闭后，调用回调函数
    // 并将代理服务器实例设置为 null，避免重复关闭或误用
    this._server.close((err?) => {
      this._server = null;
      cb?.(err);
    });
  };

  /**
   * 在指定的代理处理阶段之前插入自定义回调函数
   * @param type 类型
   * @param passName  目标阶段的名称，例如 'proxyReq'、'proxyRes'
   * @param cb 回调函数
   */
  before = <PT extends ProxyType>(
    type: PT,
    passName: string,
    cb: PassFunctions<TIncomingMessage, TServerResponse, TError>[PT],
  ) => {
    if (type !== "ws" && type !== "web") {
      throw new Error("type must be `web` or `ws`");
    }
    // 选择阶段数组
    const passes = (
      type === "ws" ? this.wsPasses : this.webPasses
    ) as PassFunctions<TIncomingMessage, TServerResponse, TError>[PT][];

    let i: false | number = false;

    passes.forEach((v, idx) => {
      if (v.name === passName) {
        i = idx;
      }
    });

    if (i === false) {
      throw new Error("No such pass");
    }
    // 插入回调函数
    passes.splice(i, 0, cb);
  };

  /**
   * 用于在指定处理阶段之后插入自定义回调的方法
   * @param type  指定代理类型，只能是 'web'（普通 HTTP）或 'ws'（WebSocket）
   * @param passName  目标阶段的名称，例如 'proxyReq'、'proxyRes'
   * @param cb 回调函数
   */
  after = <PT extends ProxyType>(
    type: PT,
    passName: string,
    cb: PassFunctions<TIncomingMessage, TServerResponse, TError>[PT],
  ) => {
    if (type !== "ws" && type !== "web") {
      throw new Error("type must be `web` or `ws`");
    }

    // 选择阶段数组
    const passes = (
      type === "ws" ? this.wsPasses : this.webPasses
    ) as PassFunctions<TIncomingMessage, TServerResponse, TError>[PT][];

    let i: false | number = false;

    passes.forEach((v, idx) => {
      if (v.name === passName) {
        i = idx;
      }
    });

    if (i === false) {
      throw new Error("No such pass");
    }

    // 插入回调函数
    passes.splice(i++, 0, cb);
  };
}
