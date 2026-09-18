import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GscAdapter, GscSummaryRow } from '../core/types.js';

export { normalizeQuery } from '../core/text.js';

export class GscError extends Error {
  constructor(
    message: string,
    readonly code: 'GSC_NOT_CONFIGURED' | 'GSC_AUTH_FAILED' | 'GSC_FETCH_FAILED',
  ) {
    super(message);
    this.name = 'GscError';
  }
}

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

async function loadServiceAccount(credentialsEnv: string): Promise<ServiceAccount> {
  const path = process.env[credentialsEnv];
  if (!path) {
    throw new GscError(`env var ${credentialsEnv} is not set`, 'GSC_NOT_CONFIGURED');
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new GscError(
      `failed to read service account file at ${path}: ${(err as Error).message}`,
      'GSC_NOT_CONFIGURED',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GscError(`service account file is not valid JSON: ${(err as Error).message}`, 'GSC_NOT_CONFIGURED');
  }
  const account = parsed as Partial<ServiceAccount>;
  if (!account.client_email || !account.private_key) {
    throw new GscError('service account JSON missing client_email/private_key', 'GSC_NOT_CONFIGURED');
  }
  return { client_email: account.client_email, private_key: account.private_key };
}

async function getAccessToken(account: ServiceAccount): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(claimSet)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(account.private_key).toString('base64url');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new GscError(`token request failed: ${res.status} ${await res.text()}`, 'GSC_AUTH_FAILED');
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export type RawGscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

/**
 * Pure mapping from raw GSC (query, page) rows to the query x page matrix
 * (DESIGN.md 9.2). No watchword matching: every row is kept, filtering into
 * a bounded top-N happens downstream in `selectTopQueries`.
 */
export function mapQueryPageRows(rows: RawGscRow[]): GscSummaryRow[] {
  return rows.map((row) => ({
    query: row.keys[0] ?? '',
    page: row.keys[1] ?? null,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
}

export class RealGscAdapter implements GscAdapter {
  constructor(private readonly credentialsEnv: string) {}

  async fetchQueryPageMatrix(input: {
    property: string;
    startDate: string;
    endDate: string;
  }): ReturnType<GscAdapter['fetchQueryPageMatrix']> {
    const account = await loadServiceAccount(this.credentialsEnv);
    const accessToken = await getAccessToken(account);

    const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
      input.property,
    )}/searchAnalytics/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: ['query', 'page'],
        rowLimit: 5000,
        dataState: 'final',
      }),
    });
    if (!res.ok) {
      throw new GscError(`searchAnalytics/query failed: ${res.status} ${await res.text()}`, 'GSC_FETCH_FAILED');
    }
    const data = (await res.json()) as { rows?: RawGscRow[] };
    return { rows: mapQueryPageRows(data.rows ?? []) };
  }
}
