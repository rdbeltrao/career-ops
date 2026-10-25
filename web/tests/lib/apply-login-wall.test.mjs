// Tests for the login-wall decision the Apply proxy makes before it claims a
// page as an application form.
//
// The bug this pins: a LinkedIn posting opened in a fresh browser lands on the
// LinkedIn sign-in form. That form has an email field, which is enough for the
// application-form heuristic, so the proxy re-rendered a login form and asked
// the planner to pre-fill it. The login check has to win over the form check.
//
// Run:  node --test tests/lib/apply-login-wall.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoginWall, isLoginUrl, LOGIN_WALL_MESSAGE } from "../../src/lib/apply/login-wall.mjs";

const email = { id: "co0", type: "email", label: "Email or phone", required: true };
const passwordAsText = { id: "co1", type: "text", label: "Password", required: true };

test("isLoginWall: a page with a password input is a login wall, even with an email field", () => {
  assert.equal(isLoginWall({ url: "https://www.linkedin.com/jobs/view/123", hasPassword: true, fields: [email] }), true);
});

test("isLoginWall: a password-labelled field counts when the DOM flag was not read", () => {
  // extract.ts maps <input type=password> to type "text", so the label is the signal
  assert.equal(isLoginWall({ url: "https://example.com/apply", hasPassword: false, fields: [email, passwordAsText] }), true);
  assert.equal(isLoginWall({ url: "https://example.com/apply", fields: [{ id: "x", type: "text", label: "Passwort", required: true }] }), true);
});

test("isLoginWall: login and auth-wall URLs are walls without any field", () => {
  for (const url of [
    "https://www.linkedin.com/login?session_redirect=x",
    "https://www.linkedin.com/authwall?trk=x",
    "https://www.linkedin.com/uas/login",
    "https://www.linkedin.com/checkpoint/lg/sign-in-another-account",
    "https://acme.icims.com/jobs/1/login",
    "https://accounts.example.com/signin",
    "https://example.com/auth/realms/x",
  ]) {
    assert.equal(isLoginWall({ url, hasPassword: false, fields: [] }), true, url);
  }
});

test("isLoginWall: an ordinary application form is not a wall", () => {
  const fields = [
    email,
    { id: "co2", type: "text", label: "First name", required: true },
    { id: "co3", type: "file", label: "Resume/CV", required: true },
  ];
  assert.equal(isLoginWall({ url: "https://job-boards.greenhouse.io/acme/jobs/123", hasPassword: false, fields }), false);
  assert.equal(isLoginWall({ url: "https://jobs.ashbyhq.com/acme/abc/application", hasPassword: false, fields }), false);
});

test("isLoginUrl: path words inside a slug do not count", () => {
  // "authentication-engineer" names the role, it is not an /auth/ route
  assert.equal(isLoginUrl("https://jobs.lever.co/acme/authentication-engineer"), false);
  assert.equal(isLoginUrl("https://acme.com/careers/accountant"), false);
  assert.equal(isLoginUrl("not a url"), false);
});

test("LOGIN_WALL_MESSAGE tells the user what to do next", () => {
  assert.match(LOGIN_WALL_MESSAGE, /sign in/i);
  assert.match(LOGIN_WALL_MESSAGE, /application-form URL/);
});
