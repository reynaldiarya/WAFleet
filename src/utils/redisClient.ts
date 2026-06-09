import { Redis as RedisClient } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const redis =
  env.REDIS_URL && env.REDIS_URL.length > 0
    ? new RedisClient(env.REDIS_URL)
    : env.REDIS_SOCKET_PATH && env.REDIS_SOCKET_PATH.length > 0
      ? new RedisClient({ path: env.REDIS_SOCKET_PATH })
      : new RedisClient({
          host: env.REDIS_HOST,
          port: env.REDIS_PORT,
          password: env.REDIS_PASSWORD,
        });

redis.on('connect', () => logger.info('[redis] connect'));
redis.on('ready', () => logger.info('[redis] ready'));
redis.on('end', () => logger.warn('[redis] end'));
redis.on('reconnecting', () => logger.warn('[redis] reconnecting'));
redis.on('error', (e) => logger.error({ err: e }, '[redis] error'));
