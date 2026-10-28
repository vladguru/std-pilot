# Сборка в контексте корня репозитория (рабочее пространство pnpm; правило переносимости, спека, п. 11).
# Файл pnpm-lock.yaml должен быть в репозитории: его создаёт первое выполнение «make deps».
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter web build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER 1000:1000
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
