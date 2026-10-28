-- Образец первой миграции (формат dbmate): замените таблицу своей схемой, сохранив порядок up / down.
-- Каждая миграция обратима: down возвращает схему к состоянию до up. Миграцию можно повторить после сбоя.

-- migrate:up
SET lock_timeout = '5s';
SET statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- migrate:down
SET lock_timeout = '5s';
SET statement_timeout = '30s';
DROP TABLE IF EXISTS clients;
