import { userInfo } from "node:os";

/** Who a request is acting for. Everything downstream keys on this, never on how it was obtained. */
export interface Principal {
  id: string;
  roles?: string[];
  tenant?: string;
  /** Free-form attributes a provider wants to carry (email, issuer, ...). Never secrets. */
  claims?: Record<string, string>;
}

/** What a provider gets to look at. Transport-specific fields are absent when they do not apply. */
export interface IdentityContext {
  transport: "stdio" | "http";
  headers?: Record<string, string | string[] | undefined>;
  /** Verified auth info supplied by the transport layer, when it did the verification itself. */
  authInfo?: { clientId?: string; scopes?: string[]; extra?: Record<string, unknown> };
}

/**
 * Resolves the principal for a connection or request. Returning `undefined` means "not authenticated";
 * the proxy refuses such requests on any transport other than a local stdio pipe, so a misconfigured
 * provider fails closed.
 */
export interface IdentityProvider {
  readonly name: string;
  resolve(ctx: IdentityContext): Promise<Principal | undefined>;
}

/** The operating-system user that launched the process. The implicit identity of every local MCP server. */
export class LocalIdentityProvider implements IdentityProvider {
  readonly name = "local";
  private readonly principal: Principal;

  constructor() {
    const user = safeUserInfo();
    this.principal = { id: `local:${user}`, roles: ["local"], claims: { user } };
  }

  async resolve(ctx: IdentityContext): Promise<Principal | undefined> {
    return ctx.transport === "stdio" ? this.principal : undefined;
  }
}

/** Bearer tokens from configuration mapped to principals. For a small shared instance without an identity server. */
export class StaticTokenIdentityProvider implements IdentityProvider {
  readonly name = "static";
  private readonly byToken: Map<string, Principal>;

  constructor(tokens: Record<string, Principal>) {
    this.byToken = new Map(Object.entries(tokens));
  }

  async resolve(ctx: IdentityContext): Promise<Principal | undefined> {
    const token = bearerFrom(ctx.headers);
    return token ? this.byToken.get(token) : undefined;
  }
}

/**
 * Trusts a header set by a gateway that already authenticated the user. Only safe when the proxy is
 * reachable solely through that gateway; the config has to say so explicitly.
 */
export class TrustedHeaderIdentityProvider implements IdentityProvider {
  readonly name = "trusted-header";

  constructor(
    private readonly header = "x-forwarded-user",
    private readonly rolesHeader = "x-forwarded-roles",
  ) {}

  async resolve(ctx: IdentityContext): Promise<Principal | undefined> {
    const id = single(ctx.headers?.[this.header]);
    if (!id) return undefined;
    const roles = single(ctx.headers?.[this.rolesHeader]);
    return { id, ...(roles ? { roles: roles.split(",").map((r) => r.trim()).filter(Boolean) } : {}) };
  }
}

function bearerFrom(headers: IdentityContext["headers"]): string | undefined {
  const value = single(headers?.authorization ?? headers?.Authorization);
  const m = value ? /^Bearer\s+(\S+)$/i.exec(value) : null;
  return m?.[1];
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function safeUserInfo(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}
