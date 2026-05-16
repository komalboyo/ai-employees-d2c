/**
 * Tiny HTTP abstraction so connectors can swap between live API calls
 * and on-disk fixtures. Live mode uses Node's global fetch; fixture
 * mode reads JSON files keyed by `${source}/${resource}/page-${n}.json`.
 *
 * This is what lets the reviewer run a working demo without real
 * Shopify/Meta/Shiprocket credentials.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface Fetcher {
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<HttpResponse>;
  post?(
    url: string,
    body: unknown,
    opts?: { headers?: Record<string, string> }
  ): Promise<HttpResponse>;
}

export class LiveFetcher implements Fetcher {
  async get(url: string, opts: { headers?: Record<string, string> } = {}): Promise<HttpResponse> {
    const res = await globalThis.fetch(url, { method: "GET", headers: opts.headers });
    return { status: res.status, body: await res.json() };
  }
  async post(
    url: string,
    body: unknown,
    opts: { headers?: Record<string, string> } = {}
  ): Promise<HttpResponse> {
    const res = await globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
}

/**
 * Reads fixtures from `fixtures/{merchant}/{source}/{resource}/page-{n}.json`.
 * Connectors pass `{source}/{resource}/page-{n}` as the URL when running
 * in fixture mode; the fetcher translates it into a file read.
 */
export class FixtureFetcher implements Fetcher {
  constructor(private readonly merchantSlug: string, private readonly root = "fixtures") {}
  async get(virtualUrl: string): Promise<HttpResponse> {
    const file = path.join(this.root, this.merchantSlug, `${virtualUrl}.json`);
    try {
      const body = JSON.parse(await readFile(file, "utf-8"));
      return { status: 200, body };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: 404, body: null };
      }
      throw e;
    }
  }
}
