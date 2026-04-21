# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.26-alpine3.23 AS builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod .
COPY go.sum .
RUN go mod download
COPY . .
RUN  \
    --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /out/ .

FROM alpine:3.23
LABEL org.opencontainers.image.source=https://github.com/sentriz/lochis
RUN apk add -U --no-cache su-exec
COPY --from=builder /out/* /usr/local/bin/
COPY docker-entry /
ENTRYPOINT ["/docker-entry"]
CMD ["lochis"]
