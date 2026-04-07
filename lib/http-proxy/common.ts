import type {
  NormalizedServerOptions,
  ProxyTargetDetailed,
  ServerOptions,
} from "./index";
import { type IncomingMessage as Request } from "node:http";
import { TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import * as urllib from "node:url";

const upgradeHeader = /(^|,)\s*upgrade\s*($|,)/i;

// Simple Regex for testing if protocol is https
export const isSSL = /^https|wss/;

type Outgoing0 = ProxyTargetDetailed & ServerOptions;

export interface Outgoing extends Outgoing0 {
  rejectUnauthorized?: boolean;
  path?: string;
  headers: { [header: string]: string | string[] | undefined } & {
    overwritten?: boolean;
  };
  url: string;
}

// If we allow this header and a user sends it with a request,
// then serving this request goes into a weird broken state, which
// wastes resources.  This could be a DOS security vulnerability.
// We strip this header if it appears in any request, and then things
// work fine.
// See https://github.com/http-party/node-http-proxy/issues/1647
const HEADER_BLACKLIST = "trailer";

const HTTP2_HEADER_BLACKLIST = [
  ":method",
  ":path",
  ":scheme",
  ":authority",
  "connection",
  "keep-alive",
];

// setupOutgoing -- Copies the right headers from `options` and `req` to
// `outgoing` which is then used to fire the proxied request by calling
// http.request or https.request with outgoing as input.
// Returns Object with all required properties outgoing options.
/**
 * 负责构建和配置代理请求的出站选项。
 * 它根据输入的配置和请求信息，生成完整的出站请求配置对象，用于发起对目标服务器的代理请求
 * @param outgoing 
 * @param options 
 * @param req 
 * @param forward 
 * @returns 
 */
export function setupOutgoing(
  // Base object to be filled with required properties
  outgoing: Outgoing,
  // Config object passed to the proxy
  options: NormalizedServerOptions,
  // Request Object
  req: Request,
  // String to select forward or target
  forward?: "forward",
) {
  // the final path is target path + relative path requested by user:
  // 目标服务器确定，forward > target
  const target = options[forward || "target"]!;

  // 端口
  outgoing.port = +(
    target.port ??
    (target.protocol !== undefined && isSSL.test(target.protocol) ? 443 : 80)
  );

  // 复制目标服务器的各种属性到出站请求配置
  for (const e of [
    "host",
    "hostname",
    "socketPath",
    "pfx",
    "key",
    "passphrase",
    "cert",
    "ca",
    "ciphers",
    "secureProtocol",
  ] as const) {
    // @ts-expect-error -- this mapping is valid
    outgoing[e] = target[e];
  }

  outgoing.method = options.method || req.method;
  outgoing.headers = { ...req.headers };
  if (req.headers?.[":authority"]) {
    // 处理 :authority 头部，转换为 host 头部
    outgoing.headers.host = req.headers[":authority"];
  }

  if (options.headers) {
    // 应用用户配置的自定义头部（覆盖原始头部）
    outgoing.headers = { ...outgoing.headers, ...options.headers };
  }

  // note -- we do the scan in this order since
  // the header could be any case, i.e., doing
  // outgoing.headers['Trailer'] won't work, because
  // it might be {'TrAiLeR':...}
  // 头部黑名单处理
  for (const header in outgoing.headers) {
    if (HEADER_BLACKLIST == header.toLowerCase()) {
      delete outgoing.headers[header];
      break;
    }
  }

  if (req.httpVersionMajor > 1) {
    // 对于 HTTP/2 请求，删除 HTTP/2 特定的黑名单头部
    for (const header of HTTP2_HEADER_BLACKLIST) {
      delete outgoing.headers[header];
    }
  }

  // 配置了认证信息，删除原始请求的 authorization 头部
  if (options.auth) {
    delete outgoing.headers.authorization;
    outgoing.auth = options.auth;
  }

  if (options.ca) {
    outgoing.ca = options.ca;
  }

  // 对于 HTTPS 目标，设置 rejectUnauthorized 选项
  if (target.protocol !== undefined && isSSL.test(target.protocol)) {
    outgoing.rejectUnauthorized =
      typeof options.secure === "undefined" ? true : options.secure;
  }

  // 设置代理的 agent 和本地地址
  outgoing.agent = options.agent || false;
  outgoing.localAddress = options.localAddress;

  // Remark: If we are false and not upgrading, set the connection: close. This is the right thing to do
  // as node core doesn't handle this COMPLETELY properly yet.
  if (!outgoing.agent) {
    outgoing.headers = outgoing.headers || {};
    if (
      typeof outgoing.headers.connection !== "string" ||
      !upgradeHeader.test(outgoing.headers.connection)
    ) {
      outgoing.headers.connection = "close";
    }
  }

  // target if defined is a URL object so has attribute "pathname", not "path".
  const targetPath =
    target && options.prependPath !== false && "pathname" in target
      ? getPath(`${target.pathname}${target.search ?? ""}`)
      : "/";

  let outgoingPath = options.toProxy ? req.url : getPath(req.url);

  // Remark: ignorePath will just straight up ignore whatever the request's
  // path is. This can be labeled as FOOT-GUN material if you do not know what
  // you are doing and are using conflicting options.
  outgoingPath = !options.ignorePath ? outgoingPath : "";

  outgoing.path = urlJoin(targetPath, outgoingPath ?? "");

  // 如果 changeOrigin 为 true，修改 host 头部
  if (options.changeOrigin) {
    outgoing.headers.host =
      target.protocol !== undefined &&
        required(outgoing.port, target.protocol) &&
        !hasPort(outgoing.host)
        ? outgoing.host + ":" + outgoing.port
        : outgoing.host;
  }

  // 完整 URL 构建
  outgoing.url = ("href" in target &&
    target.href) ||
    (target.protocol === "https" ? "https" : "http") +
    "://" +
    outgoing.host +
    (outgoing.port ? ":" + outgoing.port : "");

    // HTTP/2 头部处理
    // 再次处理 HTTP/2 头部黑名单
  if (req.httpVersionMajor > 1) {
    for (const header of HTTP2_HEADER_BLACKLIST) {
      delete outgoing.headers[header];
    }
  }

  return outgoing;
}

// Set the proper configuration for sockets,
// set no delay and set keep alive, also set
// the timeout to 0.
// Return the configured socket.
/**
 * 
 * @param socket 
 * @returns 
 */
export function setupSocket(socket: Socket): Socket {
  // 设置socket超时时间为0，确保 socket 不会因为超时而自动关闭
  socket.setTimeout(0);
  // 设置socket不使用Nagle算法，减少延迟，提高响应速度
  socket.setNoDelay(true);
  // 设置socket保持连接，检测连接是否仍然有效，防止连接静默失效
  socket.setKeepAlive(true, 0);
  return socket;
}

// Get the port number from the host. Or guess it based on the connection type.
/**
 * 
 * @param req 
 * @returns 
 */
export function getPort(
  // Incoming HTTP request.
  req: Request,
  // Return the port number, as a string.
): string {
  const hostHeader = (req.headers[":authority"] as string | undefined) || req.headers.host;
  const res = hostHeader ? hostHeader.match(/:(\d+)/) : "";
  return res ? res[1] : hasEncryptedConnection(req) ? "443" : "80";
}

// Check if the request has an encrypted connection.
/**
 * 
 * @param req 
 * @returns 
 */
export function hasEncryptedConnection(
  // Incoming HTTP request.
  req: Request,
): boolean {
  const conn = req.connection;
  return (
    (conn instanceof TLSSocket && conn.encrypted) || Boolean((conn as any).pair)
  );
}

// OS-agnostic join (doesn't break on URLs like path.join does on Windows)>
export function urlJoin(...args: string[]): string {
  // join url and merge all query string.
  const queryParams: string[] = [];
  let queryParamRaw = "";

  args.forEach((url, index) => {
    const qpStart = url.indexOf("?");
    if (qpStart !== -1) {
      queryParams.push(url.substring(qpStart + 1));
      args[index] = url.substring(0, qpStart);
    }
  });
  queryParamRaw = queryParams.filter(Boolean).join("&");

  // Join all strings, but remove empty strings so we don't get extra slashes from
  // joining e.g. ['', 'am'].
  // Also we respect strings that start and end in multiple slashes, e.g., so
  //  ['/', '//test', '///foo'] --> '//test'
  // since e.g., http://localhost//test///foo is a valid URL. See
  // lib/test/http/double-slashes.test.ts
  // The algorithm for joining is just straightforward and simple, instead
  // of the complicated "too clever" code from http-proxy. This just concats
  // the strings together, not adding any slashes, and also combining adjacent
  // slashes in two segments, e.g., ['/foo/','/bar'] --> '/foo/bar'
  let retSegs = "";
  for (const seg of args) {
    if (!seg) {
      continue;
    }
    if (retSegs.endsWith("/")) {
      if (seg.startsWith("/")) {
        retSegs += seg.slice(1);
      } else {
        retSegs += seg;
      }
    } else {
      if (seg.startsWith("/")) {
        retSegs += seg;
      } else {
        retSegs += "/" + seg;
      }
    }
  }

  // Only join the query string if it exists so we don't have trailing a '?'
  // on every request
  return queryParamRaw ? retSegs + "?" + queryParamRaw : retSegs;
}

// Rewrites or removes the domain of a cookie header
export function rewriteCookieProperty(
  header: string,
  config: Record<string, string>,
  property: string,
): string;
export function rewriteCookieProperty(
  header: string | string[],
  config: Record<string, string>,
  property: string,
): string | string[];

/**
 * 
 * @param header 
 * @param config 
 * @param property 
 * @returns 
 */
export function rewriteCookieProperty(
  header: string | string[],
  // config = mapping of domain to rewritten domain.
  //         '*' key to match any domain, null value to remove the domain.
  config: Record<string, string>,
  property: string,
): string | string[] {
  if (Array.isArray(header)) {
    return header.map((headerElement) => {
      return rewriteCookieProperty(headerElement, config, property);
    });
  }
  return header.replace(
    new RegExp("(;\\s*" + property + "=)([^;]+)", "i"),
    (match, prefix, previousValue) => {
      let newValue;
      if (previousValue in config) {
        newValue = config[previousValue];
      } else if ("*" in config) {
        newValue = config["*"];
      } else {
        //no match, return previous value
        return match;
      }
      if (newValue) {
        //replace value
        return prefix + newValue;
      } else {
        //remove value
        return "";
      }
    },
  );
}

// Check the host and see if it potentially has a port in it (keep it simple)
/**
 * 检查主机字符串中是否包含端口号
 * @param host 主机字符串
 * @returns 是否包含端口号
 */
function hasPort(host: string): boolean {
  // 使用 ~ 运算符对 indexOf 的结果进行按位非操作
  return !!~host.indexOf(":");
}

/**
 * 从 URL 字符串中提取路径部分，包括路径名（pathname）和查询参数（search）
 * @param url 
 * @returns 
 */
function getPath(url?: string): string {
  // 空字符串或查询参数直接返回原字符串
  if (url === "" || url?.startsWith("?")) {
    return url;
  }
  // 转换为 URL 对象，提取路径部分和查询参数部分
  // 一个完整的 URL 通常包含以下部分：
  // 协议（scheme）：如 http://、https://
  // 主机（host）：如 example.com
  // 端口（port）：如 :8080
  // 路径（pathname）：如 /api/users
  // 查询参数（query）：如 ?id=1&name=test
  // 片段（fragment）：如 #section1
  const u = toURL(url);
  return `${u.pathname ?? ""}${u.search ?? ""}`;
}

/**
 * 
 * @param url 
 * @returns 
 */
export function toURL(
  url: URL | urllib.Url | ProxyTargetDetailed | string | undefined,
): URL {
  // 如果 url 是 URL 对象，直接返回 url
  if (url instanceof URL) {
    return url;

    // 如果url 是对象且有 href 属性，将 href 转换为字符串并赋值给 url
  } else if (
    typeof url === "object" &&
    "href" in url &&
    typeof url.href === "string"
  ) {
    url = url.href;
  }
  // 如果 url 为空，将其转换为空字符串
  if (!url) {
    url = "";
  }

  // 如果输入不是字符串，通过模板字符串转换为字符串
  if (typeof url != "string") {
    // it has to be a string at this point, but to keep typescript happy:
    url = `${url}`;
  }

  // 处理以 // 开头的 URL（网络路径引用）
  // 添加 http://base.invalid 前缀，确保 URL 构造函数能正确解析
  if (url.startsWith("//")) {
    // special case -- this would be viewed as a this is a "network-path reference",
    // so we explicitly prefix with our http schema.  See
    url = `http://base.invalid${url}`;
  }
  // urllib.Url is deprecated but we support it by converting to URL
  return new URL(url, "http://base.invalid");
}

// vendor simplified version of https://www.npmjs.com/package/requires-port to
// reduce dep and add typescript.
/**
 * 判断是否需要在 URL 中显式指定端口号
 * @param port 端口号
 * @param protocol 协议
 * @returns 是否需要显式指定端口号
 */
function required(port: number, protocol: string): boolean {
  // 从协议字符串中提取协议名称，去掉冒号部分
  protocol = protocol.split(":")[0];

  // 确保端口号为数字类型，使用一元加号运算符进行类型转换
  port = +port;

  if (!port) return false;

  switch (protocol) {
    case "http":
    case "ws":
      // 如果端口不是默认的 80，返回 true（需要指定）
      return port !== 80;

    case "https":
    case "wss":
      // 如果端口不是默认的 443，返回 true（需要指定）
      return port !== 443;
  }

  return port !== 0;
}
