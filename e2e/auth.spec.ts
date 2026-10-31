import { test, expect, SESSION_COOKIE_NAME } from "./fixtures";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";

test("protected pages redirect to sign-in and OAuth state is bound to the browser", async ({ page }) => {
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("https://github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Mock GitHub OAuth</title>" }),
  );

  await page.goto("/pull-requests");
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "Sign in to SentinelPR" })).toBeVisible();

  const authorizeRequestPromise = page.waitForRequest((request) => {
    const requestUrl = request.url();
    return requestUrl.startsWith("https://github.com/login/oauth/authorize?");
  });
  await page.getByText("Continue with GitHub", { exact: true }).click();
  const authorizeRequest = await authorizeRequestPromise;
  const authorizeUrl = new URL(authorizeRequest.url());
  expect(authorizeUrl.searchParams.get("client_id")).toBe("e2e-client-id");
  expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/api/auth/github/callback`);
  const state = authorizeUrl.searchParams.get("state");
  expect(state).toBeTruthy();

  const stateCookie = (await page.context().cookies(`${BASE_URL}/api/auth/github/callback`)).find(
    (cookie) => cookie.name === "sentinel_oauth_state",
  );
  expect(stateCookie).toBeDefined();
  expect(stateCookie?.httpOnly).toBe(true);
  expect(stateCookie?.sameSite).toBe("Lax");

  const callbackUrl = new URL("/api/auth/github/callback", BASE_URL);
  callbackUrl.searchParams.set("code", "not-exchanged");
  callbackUrl.searchParams.set("state", "tampered-state");
  const callbackResponse = await page.request.get(callbackUrl.toString(), { maxRedirects: 0 });
  expect(callbackResponse.status()).toBe(307);
  const redirect = callbackResponse.headers()["location"];
  expect(redirect).toBeTruthy();
  const errorUrl = new URL(redirect!, BASE_URL);
  expect(errorUrl.pathname).toBe("/signin");
  expect(errorUrl.searchParams.get("error")).toMatch(/expired or invalid/i);
  expect((await page.context().cookies(`${BASE_URL}/api/auth/github/callback`)).some((cookie) => cookie.name === "sentinel_oauth_state")).toBe(false);
});

test("a seeded OAuth session persists across navigation and sign-out revokes it", async ({ page, e2e }) => {
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("complementary").getByText(e2e.organizationName, { exact: true })).toBeVisible();

  const sessionResponse = await page.request.get(`${BASE_URL}/api/session`);
  expect(sessionResponse.ok()).toBe(true);
  const sessionBody = (await sessionResponse.json()) as {
    mode: string;
    user: { email: string; githubLogin: string } | null;
    organization: { organizationId: string } | null;
  };
  expect(sessionBody.mode).toBe("oauth");
  expect(sessionBody.user?.email).toBe(e2e.email);
  expect(sessionBody.user?.githubLogin).toBe(e2e.githubLogin);
  expect(sessionBody.organization?.organizationId).toBe(e2e.organizationId);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin(?:\?.*)?$/);

  const anonymousResponse = await page.request.get(`${BASE_URL}/api/session`);
  expect(anonymousResponse.ok()).toBe(true);
  const anonymousBody = (await anonymousResponse.json()) as { user: unknown; organization: unknown };
  expect(anonymousBody.user).toBeNull();
  expect(anonymousBody.organization).toBeNull();
  expect((await page.context().cookies(BASE_URL)).some((cookie) => cookie.name === SESSION_COOKIE_NAME)).toBe(false);

  const persistedSession = await e2e.pool.query('SELECT "id" FROM "Session" WHERE "id" = $1', [e2e.sessionId]);
  expect(persistedSession.rowCount).toBe(0);
});
