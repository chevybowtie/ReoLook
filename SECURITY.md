# Security

## Reporting a problem

Please report security problems privately, not in a public issue: use GitHub's
**Security > Report a vulnerability** on this repository. If that is not available, open an issue
that says only that you have a security report, and leave out the details until a private channel
is arranged.

Include what you did, what you expected, what happened, the ReoLook version (`package.json`) and
your Node.js version. Remove camera passwords, addresses and recordings from anything you send.

This is a small volunteer project: expect an acknowledgement within a few days, not a guaranteed
fix time.

## What ReoLook is designed to protect

- The server listens on `127.0.0.1` only and refuses requests with any other `Host` header.
- State-changing requests must come from the page itself (same-origin check).
- Camera passwords are never written to `config.json`. Administrator passwords are held in
  memory only, are forgotten after 15 minutes idle, and the browser gets only an HttpOnly,
  SameSite=Strict session cookie.
- Camera passwords that ffmpeg echoes in its error messages are masked before they reach logs or
  the status page. Rebooting a camera from a live tile needs the administrator sign-in, a
  same-origin request and an explicit confirmation.
- Risky device changes show the exact difference first, are verified by reading back, and the
  most dangerous ones need the target typed to confirm.
- No telemetry and no cloud account.

## Known limits (not vulnerabilities)

- Camera passwords are passed to ffmpeg inside the RTSP address, so other users on the same
  computer can see them in the process list. Use a read-only camera account for viewing.
- Anyone who can use your computer's loopback interface or your browser session can use ReoLook.
  Do not expose it with a reverse proxy or tunnel unless you add your own authentication in front.
- Camera and MQTT sign-ins live in `~/.config/reolook/env` (mode 600). Detection web addresses
  (webhooks) are stored in `config.json`, so do not put a secret token in one you plan to share.
- Reolink cameras themselves have their own security record; keep their firmware up to date and
  keep them off the internet.

## Supported versions

Only the latest release is supported.
