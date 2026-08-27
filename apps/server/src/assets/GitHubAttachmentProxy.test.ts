import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubAttachmentProxy from "./GitHubAttachmentProxy.ts";

const ATTACHMENT_URL = "https://github.com/user-attachments/assets/4dcab2ba";
const STORAGE_URL = "https://objects.example.test/signed/4dcab2ba";

const notImplemented = () => Effect.die("not implemented in this test");

const makeGitHubCliLayer = (input: {
  readonly calls: Array<ReadonlyArray<string>>;
  readonly fail?: boolean;
}) =>
  Layer.succeed(
    GitHubCli.GitHubCli,
    GitHubCli.GitHubCli.of({
      execute: ({ args }) => {
        input.calls.push(args);
        if (input.fail) {
          return Effect.fail(
            new GitHubCli.GitHubCliUnavailableError({
              command: "gh",
              cwd: "/tmp",
              cause: "gh is not installed",
            }),
          );
        }
        return Effect.succeed({
          exitCode: ExitCode(0),
          stdout: "gh-token-1\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
      listOpenPullRequests: notImplemented,
      getPullRequest: notImplemented,
      getRepositoryCloneUrls: notImplemented,
      createRepository: notImplemented,
      createPullRequest: notImplemented,
      getDefaultBranch: notImplemented,
      checkoutPullRequest: notImplemented,
    }),
  );

type RecordedRequest = { readonly url: string; readonly authorization: string | undefined };

const makeHttpClientLayer = (input: {
  readonly requests: Array<RecordedRequest>;
  readonly status?: number;
  readonly location?: string;
}) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        input.requests.push({ url: request.url, authorization: request.headers["authorization"] });
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: input.status ?? 302,
            headers: input.location === undefined ? {} : { location: input.location },
          }),
        );
      }),
    ),
  );

const provideProxy = (input: {
  readonly calls?: Array<ReadonlyArray<string>>;
  readonly requests?: Array<RecordedRequest>;
  readonly cliFails?: boolean;
  readonly status?: number;
  readonly location?: string;
}) =>
  Effect.provide(
    GitHubAttachmentProxy.layer.pipe(
      Layer.provide(
        makeGitHubCliLayer({
          calls: input.calls ?? [],
          ...(input.cliFails !== undefined ? { fail: input.cliFails } : {}),
        }),
      ),
      Layer.provide(
        makeHttpClientLayer({
          requests: input.requests ?? [],
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
        }),
      ),
      Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-gh-proxy-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

describe("GitHubAttachmentProxy", () => {
  it.effect("resolves the redirect with the gh token and caches the token read", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const requests: Array<RecordedRequest> = [];
      yield* Effect.gen(function* () {
        const proxy = yield* GitHubAttachmentProxy.GitHubAttachmentProxy;
        expect(yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL)).toBe(STORAGE_URL);
        expect(yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL)).toBe(STORAGE_URL);
      }).pipe(provideProxy({ calls, requests, location: STORAGE_URL }));

      expect(requests.map((request) => request.authorization)).toEqual([
        "token gh-token-1",
        "token gh-token-1",
      ]);
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }),
  );

  it.effect("still resolves anonymously when no gh token is available", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedRequest> = [];
      yield* Effect.gen(function* () {
        const proxy = yield* GitHubAttachmentProxy.GitHubAttachmentProxy;
        expect(yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL)).toBe(STORAGE_URL);
      }).pipe(provideProxy({ requests, cliFails: true, location: STORAGE_URL }));

      expect(requests.map((request) => request.authorization)).toEqual([undefined]);
    }),
  );

  it.effect("answers null for non-redirect responses and non-https locations", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const proxy = yield* GitHubAttachmentProxy.GitHubAttachmentProxy;
        expect(yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL)).toBeNull();
      }).pipe(provideProxy({ status: 200, location: STORAGE_URL }));

      yield* Effect.gen(function* () {
        const proxy = yield* GitHubAttachmentProxy.GitHubAttachmentProxy;
        expect(yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL)).toBeNull();
      }).pipe(provideProxy({ location: "http://plain.example.test/asset" }));

      yield* Effect.gen(function* () {
        const proxy = yield* GitHubAttachmentProxy.GitHubAttachmentProxy;
        expect(yield* proxy.resolveAttachmentLocation(ATTACHMENT_URL)).toBeNull();
      }).pipe(provideProxy({}));
    }),
  );
});
