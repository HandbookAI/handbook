# syntax=docker/dockerfile:1
# Node 22, deliberately not 24: tree-sitter-swift aborts the process on V8 >= 13
# (exit 133). Node 22 ships V8 12.4, so Swift analysis works without the
# --liftoff-only flag the test runner needs elsewhere.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig*.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# Drop dev dependencies from the tree we copy forward. `pnpm prune --prod` is
# the obvious command here, but on this pnpm version it deletes every
# workspace package's own node_modules symlinks (not just the dev ones),
# which breaks every cross-package import (`Cannot find package 'commander'`)
# — a fresh prod-only install rebuilds that symlink tree correctly instead.
# `--ignore-scripts` skips the root's own `prepare` (`husky`), which isn't
# meaningful in a container and would otherwise fail once husky is gone from
# devDependencies.
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
# A handbook run only ever needs to read /src and write /work.
RUN addgroup -S handbook && adduser -S -G handbook handbook \
 && mkdir -p /src /work && chown -R handbook:handbook /src /work
USER handbook
ENV HANDBOOK_SOURCE=/src HANDBOOK_WORK=/work
ENTRYPOINT ["node", "/app/packages/cli/dist/main.js"]
CMD ["--help"]
