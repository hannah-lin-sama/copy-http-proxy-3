/*
The passes.

A `pass` is just a function that is executed on `req, res, options`
so that you can easily add new checks while still keeping the base
flexible.

NOTE: The function in OUTGOING_PASSES are called. They are assumed
to not return anything.
*/

import type { NormalizedServerOptions, NormalizeProxyTarget, ProxyTarget } from "..";
import * as common from "../common";
import type { Request, ProxyResponse } from "./web-incoming";

const redirectRegex = /^201|30(1|2|7|8)$/;

// interface for subset of Response that's actually used here
// needed for running outgoing passes on MockResponse in ws-incoming
export interface EditableResponse {
  statusCode: number;
  statusMessage: string;
  setHeader(key: string, value: string | string[]): this;
}

// <--

// If is a HTTP 1.0 request, remove chunk headers
/*
 * 在 HTTP 协议中，头部可以分为两类：
 * 1. End-to-end 头部：这些头部会被传递给最终的消息接收者
 * 2. Hop-by-hop 头部：这些头部只对单次跳转（ hop ）有效，不会被代理服务器转发给下一跳
 * @param _req 
 * @param _res 
 * @param proxyRes 
 */
export function removeChunked(
  _req: Request,
  _res: EditableResponse,
  // Response object from the proxy request
  proxyRes: ProxyResponse,
) {
  // transfer-encoding is hop-by-hop, don't preserve it across proxy hops
  // 从代理响应的头部中删除 transfer-encoding 头部
  // Transfer-Encoding 头部用于指定消息体的传输编码方式，最常见的值是 chunked，表示使用分块传输编码。
  // 分块传输编码的特点是：
  // 1. 数据被分成多个块进行传输
  // 2. 每个块都有自己的长度指示
  // 3. 最后以一个长度为 0 的块结束
  // 4. 不需要在头部指定 Content-Length
  delete proxyRes.headers["transfer-encoding"];
}

// If is a HTTP 1.0 request, set the correct connection header
// or if connection header not present, then use `keep-alive`
/**
 * 根据客户端请求的 HTTP 版本设置代理响应的 Connection 头部，确保连接行为与 HTTP 版本相匹配
 * @param req 
 * @param _res 
 * @param proxyRes 
 */
export function setConnection(
  req: Request,
  _res: EditableResponse,
  // Response object from the proxy request
  proxyRes: ProxyResponse,
) {
  // HTTP/1.0 处理
  // 对于 HTTP/1.0 请求，默认使用 close 连接模式
  if (req.httpVersion === "1.0") {
    proxyRes.headers["connection"] = req.headers["connection"] || "close";

    // HTTP/1.1 处理
  } else if (req.httpVersion !== "2.0" && !proxyRes.headers["connection"]) {
    // 默认使用 keep-alive 连接模式
    proxyRes.headers["connection"] = req.headers["connection"] || "keep-alive";
  }
  //  HTTP/2.0 使用多路复用，不需要 Connection 头部
}

/**
 * 处理 HTTP 重定向响应，根据配置选项重写重定向的 URL。
 * @param req 
 * @param _res 
 * @param proxyRes 
 * @param options 
 * @returns 
 */
export function setRedirectHostRewrite(
  req: Request,
  _res: EditableResponse,
  proxyRes: ProxyResponse,
  options: NormalizedServerOptions & { target: NormalizeProxyTarget<ProxyTarget> },
) {

  if (
    (options.hostRewrite || options.autoRewrite || options.protocolRewrite) &&
    proxyRes.headers["location"] &&
    // 响应重定向状态码：201, 301, 302, 307, 308
    redirectRegex.test(`${proxyRes.statusCode}`)
  ) {
    const target = common.toURL(options.target);
    const location = proxyRes.headers["location"];
    if (typeof location != "string") {
      return;
    }
    const u = common.toURL(location);

    // make sure the redirected host matches the target host before rewriting
    if (target.host != u.host) {
      return;
    }

    if (options.hostRewrite) {
      u.host = options.hostRewrite;
    } else if (options.autoRewrite) {
      u.host = (req.headers[":authority"] as string | undefined) ?? req.headers["host"] ?? "";
    }
    if (options.protocolRewrite) {
      u.protocol = options.protocolRewrite;
    }

    proxyRes.headers["location"] = u.toString();
  }
}

// Copy headers from proxyRes to res.
/**
 * 将代理响应的头部设置到客户端响应对象中
 * @param _req 
 * @param res 
 * @param proxyRes 
 * @param options 
 */
export function writeHeaders(
  _req: Request,
  // Response to set headers in
  res: EditableResponse,
  // Response object from the proxy request
  proxyRes: ProxyResponse,
  // options.cookieDomainRewrite: Config to rewrite cookie domain
  options: NormalizedServerOptions & { target: NormalizeProxyTarget<ProxyTarget> },
) {
  const rewriteCookieDomainConfig =
    typeof options.cookieDomainRewrite === "string"
      ? // also test for ''
      { "*": options.cookieDomainRewrite }
      : options.cookieDomainRewrite;

  const rewriteCookiePathConfig =
    typeof options.cookiePathRewrite === "string"
      ? // also test for ''
      { "*": options.cookiePathRewrite }
      : options.cookiePathRewrite;

  // 是否保留头部键大小写的配
  const preserveHeaderKeyCase = options.preserveHeaderKeyCase;
  const setHeader = (key: string, header: string | string[]) => {
    if (header == undefined) {
      return;
    }
    // 重写 cookie 的 domain属性
    if (rewriteCookieDomainConfig && key.toLowerCase() === "set-cookie") {
      header = common.rewriteCookieProperty(
        header,
        rewriteCookieDomainConfig,
        "domain",
      );
    }
    // 重写 cookie 的 path 属性
    if (rewriteCookiePathConfig && key.toLowerCase() === "set-cookie") {
      header = common.rewriteCookieProperty(
        header,
        rewriteCookiePathConfig,
        "path",
      );
    }
    res.setHeader(String(key).trim(), header);
  };

  // message.rawHeaders is added in: v0.11.6
  // https://nodejs.org/api/http.html#http_message_rawheaders
  let rawHeaderKeyMap: undefined | { [key: string]: string };
  if (preserveHeaderKeyCase && proxyRes.rawHeaders != undefined) {
    rawHeaderKeyMap = {};
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      const key = proxyRes.rawHeaders[i];
      rawHeaderKeyMap[key.toLowerCase()] = key;
    }
  }

  for (const key0 in proxyRes.headers) {
    let key = key0;

    // 对于 HTTP/2 客户端，跳过 connection 和 keep-alive 头部（HTTP/2 不需要这些头部）
    if (_req.httpVersionMajor > 1 && (key === "connection" || key === "keep-alive")) {
      // don't send connection header to http2 client
      continue;
    }
    const header = proxyRes.headers[key];
    if (preserveHeaderKeyCase && rawHeaderKeyMap) {
      key = rawHeaderKeyMap[key] ?? key;
    }
    setHeader(key, header);
  }
}

// Set the statusCode from the proxyResponse
/**
 * 将代理响应的 HTTP 状态码和状态消息设置到客户端响应对象中，确保客户端能够接收到与目标服务器相同的状态信息
 * @param _req 
 * @param res 
 * @param proxyRes 
 */
export function writeStatusCode(
  _req: Request,
  res: EditableResponse,
  proxyRes: ProxyResponse,
) {
  // From Node.js docs: response.writeHead(statusCode[, statusMessage][, headers])
  // 将代理响应的状态码设置到客户端响应对象中
  res.statusCode = proxyRes.statusCode!;

  // HTTP/1.x 版本时，才设置状态消息
  if (proxyRes.statusMessage && _req.httpVersionMajor === 1) {
    res.statusMessage = proxyRes.statusMessage;
  }
  // HTTP/2.0 及以上版本不使用状态消息，因此不需要设置
}

export const OUTGOING_PASSES = {
  removeChunked,
  setConnection,
  setRedirectHostRewrite,
  writeHeaders,
  writeStatusCode,
};
