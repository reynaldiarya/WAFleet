# WAFleet

**WAFleet** is an unofficial WhatsApp API built on top of the reverse-engineered **WhatsApp Web** protocol via **[Baileys](https://github.com/WhiskeySockets/Baileys)**. It lets you automate messaging, manage sessions, and integrate WhatsApp into your systems through a lightweight REST API.

> ⚠️ **Disclaimer**  
> This project is **unofficial** and not affiliated with WhatsApp Inc. Use at your own risk and follow WhatsApp’s Terms of Service. Numbers that violate their terms may be blocked.

---

## ✨ Features

- ✅ **Baileys-based** WhatsApp Web client
- ✅ **Multiple sessions** (one token per session)
- ✅ **Token auth (Bearer)** — no expiry by design, manual revoke
- ✅ **Send text messages**
- ✅ **Login with QR** (QR rendered in terminal, endpoint to fetch last QR)
- ✅ **Session persistence in Redis** (Baileys creds & signal keys)
- ✅ **Graceful reconnect** with exponential backoff
- ✅ **Rate limiting, CORS, security headers, structured logs (pino)**

> Current endpoints focus on texting & session lifecycle. You can extend to media, groups, webhooks, etc. using Baileys events.

---

## 🧱 Stack

- **Runtime**: Node.js + Express (TypeScript)
- **WhatsApp client**: Baileys
- **Storage**: Redis (credentials, signal keys, token → session mapping)
- **Auth**: `Authorization: Bearer <token>`
- **Logging**: pino / pino-http
- **Security**: helmet, CORS, express-rate-limit

---

## ⚙️ Requirements

- Node.js 18+ (or 20+)
- Redis 6+ (persistence enabled if you want sessions to survive restarts)
- A WhatsApp number to pair

---

## 🚀 Quick Start

```bash
# 1) Install deps
npm install

# 2) Copy env and edit as needed
cp .env.example .env

# 3) Run dev
npm run dev
# or build & run
npm run build && npm start
