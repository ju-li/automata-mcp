/**
 * `GET /self-host/confirmed`: where Brevo sends a self-hoster after they click
 * the double opt-in link (`BREVO_SELF_HOST_REDIRECT_URL`'s default). Static:
 * no query read, nothing stored, the address never reaches it. Styled like the
 * account emails (apps/web/server/emails/layout.ts): cream ground, ink header,
 * lime on ink.
 *
 * Served with a CSP allowing only inline styles, Google Fonts and the email
 * logo the web app already serves.
 */

export const CONFIRMED_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src https://mcp.getautomata.app',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export const CONFIRMED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>You're subscribed · Automata</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px;background:#f4f0e6;color:#17140f;font-family:'Space Grotesk',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
main{width:100%;max-width:560px;background:#fffdf7;border:1px solid #d9d3c2;border-radius:14px;overflow:hidden}
header{background:#17140f;padding:22px 32px}
header img{display:block;width:150px;height:auto}
section{padding:36px 32px 32px}
.check{width:44px;height:44px;border-radius:50%;background:#baf85a;display:flex;align-items:center;justify-content:center;margin-bottom:20px}
h1{margin:0 0 16px;font-size:30px;line-height:1.15;letter-spacing:-0.6px;font-weight:600}
p{margin:0 0 16px;font-size:17px;line-height:1.6;color:#3d382e}
.panel{background:#f4f0e6;border-radius:12px;padding:16px 18px;margin:0 0 20px;font-size:15px;line-height:1.6;color:#3d382e}
.panel strong{display:block;color:#17140f;font-weight:600;margin-bottom:4px}
a.button{display:inline-block;background:#17140f;color:#baf85a;border-radius:10px;padding:15px 24px;font-size:16px;font-weight:600;text-decoration:none}
a.button:hover{background:#2a2620}
a.button:focus-visible{outline:3px solid #baf85a;outline-offset:3px}
footer{background:#f4f0e6;border-top:1px solid #e4dece;padding:18px 32px;font-size:13px;line-height:1.6;color:#625b4c}
</style>
</head>
<body>
<main>
<header><img src="https://mcp.getautomata.app/email/automata-email-logo.png" width="150" height="36" alt="Automata"></header>
<section>
<div class="check" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#17140f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
<h1>You're subscribed.</h1>
<p>We'll email this address when a release of self-hosted Automata has breaking changes or fixes a security issue.</p>
<div class="panel"><strong>Nothing else.</strong>No marketing, no newsletters, no spam. Your address is never shared or sold, and every email has an unsubscribe link.</div>
<a class="button" href="https://www.getautomata.app">Back to Automata &rarr;</a>
</section>
<footer>Operational Intelligence Inc. · 418 Broadway #6722 · Albany, NY 12207, USA</footer>
</main>
</body>
</html>
`
