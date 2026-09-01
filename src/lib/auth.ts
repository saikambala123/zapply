import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { connectDB } from "./db";
import User from "@/models/User";

/**
 * The signing key. There is no usable fallback in production: a deployment that
 * boots without JWT_SECRET would sign every session with a constant that is
 * published in this repository, which lets anyone mint a token for any account.
 * Fail loudly at first use instead of silently running wide open.
 */
const RAW_SECRET = process.env.JWT_SECRET;
const DEV_SECRET = "dev-only-insecure-secret-change-me-in-production";

if (process.env.NODE_ENV === "production" && (!RAW_SECRET || RAW_SECRET.length < 32)) {
  throw new Error(
    "JWT_SECRET is missing or shorter than 32 characters. Set it in your Vercel project settings — generate one with `openssl rand -base64 48`."
  );
}
if (!RAW_SECRET && process.env.NODE_ENV !== "test") {
  console.warn("[auth] JWT_SECRET is not set — using the insecure development key. Never deploy like this.");
}

const SECRET = new TextEncoder().encode(RAW_SECRET || DEV_SECRET);
export const SESSION_COOKIE = "zapply_session";
const WEB_TTL = "30d";
const EXT_TTL = "180d";

export type TokenPayload = {
  sub: string;
  email: string;
  scope: "web" | "extension";
  /** Session epoch. Bumped on password reset / "sign out everywhere" to kill old tokens. */
  sv?: number;
};

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

export async function signToken(payload: TokenPayload, scope?: "web" | "extension") {
  // The explicit argument wins, but an omitted one must not silently downgrade
  // an extension token to a 30-day web token — fall back to the payload first.
  const effective = scope ?? payload.scope ?? "web";
  return new SignJWT({ ...payload, scope: effective })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(effective === "extension" ? EXT_TTL : WEB_TTL)
    .sign(SECRET);
}

export async function readToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie() {
  // Mirror the attributes used when setting it — a cookie written with
  // `secure`/`sameSite` is not reliably replaced by one written without them.
  cookies().set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * Resolves the current user from either:
 *  - the httpOnly session cookie (web dashboard), or
 *  - an `Authorization: Bearer <token>` header (browser extension).
 */
export async function getCurrentUser(req?: NextRequest) {
  const bearer = req?.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const cookieToken = cookies().get(SESSION_COOKIE)?.value;
  const token = bearer || cookieToken;
  if (!token) return null;

  const payload = await readToken(token);
  if (!payload?.sub) return null;

  await connectDB();
  const user = (await User.findById(payload.sub).select("-passwordHash").lean()) as any;
  if (!user) return null;

  // Session revocation. Resetting a password (or signing out everywhere) bumps
  // `sessionVersion`, which retires every token issued before it — including
  // the 180-day extension bearer tokens, which are otherwise unrevocable.
  const current = Number(user.sessionVersion ?? 0);
  const presented = Number(payload.sv ?? 0);
  if (presented < current) return null;

  return { ...user, _id: String(user._id) };
}

export async function requireUser(req?: NextRequest): Promise<any> {
  const user = await getCurrentUser(req);
  if (!user) throw new HttpError(401, "You need to sign in to do that.");
  return user;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
