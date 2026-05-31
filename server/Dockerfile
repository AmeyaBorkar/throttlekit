# throttlekit-server container.
# Build from the REPO ROOT (the proto is the single source in wire/):
#   docker build -f server/Dockerfile -t throttlekit-server .
# Run (mount your policy file):
#   docker run -p 50051:50051 -v "$PWD/.throttlekit.yaml:/etc/throttlekit.yaml" \
#     throttlekit-server --config /etc/throttlekit.yaml --redis redis://redis:6379

FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build
# Bundle the proto next to the build so resolveProtoPath finds it at runtime (../throttlekit.proto).
COPY wire/throttlekit.proto ./throttlekit.proto

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/throttlekit.proto ./throttlekit.proto
USER node
EXPOSE 50051
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["--help"]
