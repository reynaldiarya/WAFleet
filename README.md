# WAFleet

A high-performance, enterprise-ready WhatsApp REST API gateway built for seamless automation and integration.

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue.svg" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933.svg" />
  <img src="https://img.shields.io/badge/TypeScript-6.x-3178C6.svg" />
  <a href="LICENSE">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-yellow.svg" target="_blank" />
  </a>
</p>

## Description

WAFleet provides a robust and scalable bridge between your existing systems and the WhatsApp ecosystem. By leveraging the power of the reverse-engineered WhatsApp Web protocol, it offers a developer-friendly REST interface for automating message workflows, managing multiple sessions, and handling rich media content. WAFleet is designed for reliability, featuring distributed locking, automatic session restoration, and Redis-backed persistence to ensure your communication services remain uninterrupted and secure.

## Features

- **Scalable Session Management** - Create and manage multiple concurrent WhatsApp sessions independently via a unified API
- **Rich Media Support** - Send and receive images, videos, audio files, documents, and interactive polls with native validation
- **Reliable Persistence** - Utilize Redis for session storage and distributed locking, ensuring high availability and crash recovery
- **Advanced Interaction Simulation** - Enhance authenticity with built-in support for typing indicators and configurable message delays
- **Enterprise Security** - Hardened with Helmet security headers, granular rate limiting, and Bearer-token authentication
- **Developer-Centric Tooling** - Built with TypeScript for type safety, Zod for schema validation, and Pino for high-performance logging
- **Observable Infrastructure** - Native integration with Prometheus for real-time monitoring and metrics tracking

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Express.js 5.0
- **Language**: TypeScript 6.0
- **Protocol**: Baileys (WhatsApp Web API)
- **Data Store**: Redis (ioredis)
- **Validation**: Zod
- **Logging**: Pino & pino-http
- **Security**: Helmet & Express Rate Limit
- **Metrics**: Prometheus (prom-client)

## Installation Guide

### Prerequisites

- Node.js 20 or higher
- Redis Server (local or managed instance)
- npm or yarn package manager

### Steps

1. Clone the repository to your local machine

```bash
git clone https://github.com/reynaldiarya/WAFleet.git
cd WAFleet
```

2. Install the project dependencies

```bash
npm install
```

3. Initialize the environment configuration

```bash
cp .env.example .env
```

4. Configure your Redis connection and application settings in the `.env` file
5. Compile the TypeScript source code

```bash
npm run build
```

6. Start the production server

```bash
npm start
```

For development with hot-reloading, use:

```bash
npm run dev
```

## Configuration

WAFleet utilizes environment variables for all sensitive and system-level configurations.

### Core Settings

| Variable         | Description                                 | Default |
| ---------------- | ------------------------------------------- | ------- |
| `PORT`           | The port the REST API will listen on        | `3000`  |
| `LOG_LEVEL`      | Pino logging level (info, debug, error)     | `info`  |
| `AUTH_TOKEN_LEN` | Length of the auto-generated session tokens | `12`    |

### Redis Configuration

| Variable     | Description                         | Example                  |
| ------------ | ----------------------------------- | ------------------------ |
| `REDIS_URL`  | Full Redis connection string        | `redis://localhost:6379` |
| `REDIS_HOST` | Redis hostname (if URL is not used) | `127.0.0.1`              |
| `REDIS_PORT` | Redis port (if URL is not used)     | `6379`                   |

### Security & Limits

| Variable               | Description                      | Default |
| ---------------------- | -------------------------------- | ------- |
| `ALLOWED_ORIGINS`      | CORS whitelist (comma separated) | `*`     |
| `RATE_LIMIT_MAX`       | Maximum requests per IP window   | `100`   |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window duration       | `60000` |

## Usage

### 1. Create a New Session

Initialize a new WhatsApp session and receive a dedicated access token.

**Request:**
`POST /session`

**Response:**

```json
{
  "success": true,
  "id": "sess_8f2d1...",
  "token": "aBc123XyZ...",
  "message": "Session created."
}
```

### 2. Connect via QR Code

Retrieve the QR code for the session to link your WhatsApp account.

**Request:**
`GET /qr`
_Headers: `Authorization: Bearer <your_token>`_

### 3. Send a Message

Dispatch a text or media message to a specific number.

**Request:**
`POST /send`
_Headers: `Authorization: Bearer <your_token>`_

**Payload (JSON):**

```json
{
  "to": "628123456789",
  "text": "Hello from WAFleet!",
  "typing": true,
  "delay": 2
}
```

### 4. Send Media

Upload a file directly or provide a URL for WAFleet to fetch and send.

**Payload (Multipart/Form-Data):**

- `to`: `628123456789`
- `file`: `[Binary Data]`
- `text`: `Check this document`

## Project Structure

```text
/
├── src/
│   ├── config/           # Environment and global configurations
│   ├── services/         # Core business logic (WhatsApp, Redis, Tokens)
│   ├── utils/            # Shared helpers (Logging, Validation, JID parsing)
│   └── server.ts         # Express application entry point and routes
├── dist/                 # Compiled JavaScript output
├── .env.example          # Template for environment variables
├── package.json          # Project dependencies and scripts
└── tsconfig.json         # TypeScript compiler configuration
```

## Scripts / Commands

| Command                   | Description                                       |
| ------------------------- | ------------------------------------------------- |
| `npm run dev`             | Start development server with tsx watch           |
| `npm run build`           | Compile TypeScript and prepare dist folder        |
| `npm start`               | Execute the compiled production bundle            |
| `npm run prettier-format` | Format source code according to project standards |

## Contributing

We welcome contributions to WAFleet. To maintain code quality:

1. Fork the project and create your feature branch
2. Ensure code follows the established Prettier configuration
3. Provide descriptive commit messages
4. Submit a Pull Request for review

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for detailed terms and conditions.

## Author

Reynaldi Arya
