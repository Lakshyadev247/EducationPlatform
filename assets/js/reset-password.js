/**
 * Password reset page.
 *
 * The page is intentionally outside the single page application: the link in
 * the reset mail must work even when the app's bundle or router changes. It
 * reads the token and the address from the query string, asks the server for a
 * CSRF token and submits the new password. The token itself is never written
 * to storage and never rendered.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var token = params.get("token") || "";
  var email = params.get("email") || "";

  var form = document.getElementById("reset-form");
  var emailInput = document.getElementById("email");
  var passwordInput = document.getElementById("password");
  var confirmInput = document.getElementById("password-confirmation");
  var button = document.getElementById("submit-btn");
  var message = document.getElementById("message");
  var signinHint = document.getElementById("signin-hint");

  emailInput.value = email;

  // Apply dynamic platform brand name from settings
  fetch("/api/v1/settings")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var brand = (data && data.branding && data.branding.appName) || (data && data.general && data.general.appName);
      if (brand) {
        document.querySelectorAll("[data-brand-name]").forEach(function (el) { el.textContent = brand; });
        document.title = "Reset your password · " + brand;
      }
    })
    .catch(function () {});

  function show(kind, text) {
    message.className = "message " + (kind === "ok" ? "message--ok" : "message--error");
    message.textContent = text;
  }

  if (!token || !email) {
    show("error", "This reset link is incomplete. Request a new link from the sign-in page.");
    button.disabled = true;
    return;
  }

  function readCsrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    if (match) {
      return decodeURIComponent(match[1]);
    }

    return "";
  }

  async function ensureCsrfToken() {
    var existing = readCsrfToken();
    if (existing) {
      return existing;
    }

    var response = await fetch("/api/v1/auth/csrf", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error("Could not start a secure session.");
    }

    var payload = await response.json();
    return payload.token || readCsrfToken();
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    var password = passwordInput.value;
    var confirmation = confirmInput.value;

    if (password.length < 12) {
      show("error", "The new password must be at least 12 characters.");
      passwordInput.focus();
      return;
    }

    if (password !== confirmation) {
      show("error", "The two passwords do not match.");
      confirmInput.focus();
      return;
    }

    button.disabled = true;
    show("ok", "Saving your new password...");

    try {
      var csrf = await ensureCsrfToken();

      var response = await fetch("/api/v1/auth/password/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": csrf,
        },
        body: JSON.stringify({
          token: token,
          email: email,
          password: password,
          password_confirmation: confirmation,
        }),
      });

      var payload = await response.json().catch(function () {
        return {};
      });

      if (!response.ok) {
        var errors = payload.errors || {};
        var firstError = Object.keys(errors).length ? errors[Object.keys(errors)[0]][0] : "";
        show("error", firstError || "This reset link is invalid or has expired.");
        button.disabled = false;
        return;
      }

      form.hidden = true;
      show("ok", "Your password has been reset. You can sign in with the new password.");
      signinHint.hidden = false;
    } catch (error) {
      show("error", "We could not reach the server. Check your connection and try again.");
      button.disabled = false;
    }
  });
})();
