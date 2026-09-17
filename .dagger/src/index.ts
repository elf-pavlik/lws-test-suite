/**
 * A generated module for LwsTestSuite functions
 *
 * This module has been generated via dagger init and serves as a reference to
 * basic module structure as you get started with Dagger.
 *
 * Two functions have been pre-created. You can modify, delete, or add to them,
 * as needed. They demonstrate usage of arguments and return types using simple
 * echo and grep commands. The functions can be called from the dagger CLI or
 * from one of the SDKs.
 *
 * The first line in this comment block is a short description line and the
 * rest is a long description with more detail on the module's purpose or usage,
 * if appropriate. All modules should have a short description.
 */
import { dag, Container, Directory, object, func, Service } from "@dagger.io/dagger"

@object()
export class LwsTestSuite {
  /**
   * The lws-server source: a GitHub clone of
   * https://github.com/ebremer/lws-server (default branch), or a local
   * checkout when a source Directory is passed explicitly.
   */
  private lwsServerSource(source?: Directory): Directory {
    return source ?? dag.git("https://github.com/ebremer/lws-server").head().tree()
  }

  /**
   * Builds the lws-server (Maven / Spring Boot, JDK 25) from source into a
   * container image. Dependencies are cached in a cache volume.
   */
  private lwsServerBuild(source?: Directory): Container {
    return dag
      .container()
      .from("maven:3.9-eclipse-temurin-25")
      .withMountedCache("/root/.m2/repository", dag.cacheVolume("lws-m2"))
      .withDirectory("/src", this.lwsServerSource(source))
      .withWorkdir("/src")
      .withExec(["mvn", "-q", "-DskipTests", "package"])
  }

  /**
   * Builds and starts the lws-server, returned as a Dagger service.
   *
   * The server runs in LWS "open mode" (no owners, lws.dev.open=true) so it
   * accepts anonymous requests without configuration. It listens on port 8080
   * (derived from the default lws.base-uri=http://localhost:8080).
   *
   * The source defaults to a clone of https://github.com/ebremer/lws-server;
   * pass --source with a local checkout to test uncommitted changes.
   *
   * Bind it from another container with withServiceBinding("lws-server", svc)
   * or expose it to the host with `dagger call lws-server ... up --ports 8080:8080`.
   */
  @func()
  lwsServer(source?: Directory): Service {
    return this.lwsServerBuild(source)
      .withExposedPort(8080)
      .asService({
        args: [
          "java",
          "-Dlws.dev.open=true",
          "-Dlws.owners=",
          "-Dlws.require-https=false",
          "-jar",
          "target/lws-server.jar",
        ],
      })
      .withHostname("lws-server")
  }

  /**
   * Starts the lws-server bound as "lws-server" and calls it from a
   * test-harness container that for now just uses curl.
   *
   * The harness curls the LWS storage description (/.lws/storage-description),
   * retrying while the server boots (TDB2 first-run initialization), and fails
   * the run unless it gets a 200 response.
   */
  @func()
  async test(source?: Directory): Promise<string> {
    const server = this.lwsServer(source)
    return dag
      .container()
      .from("alpine:latest")
      .withExec(["apk", "add", "--no-cache", "curl"])
      .withServiceBinding("lws-server", server)
      .withExec([
        "sh",
        "-c",
        "curl -fsS " +
          "--retry 60 --retry-all-errors --retry-delay 1 " +
          "-H 'Accept: application/ld+json' " +
          "http://lws-server:8080/.lws/storage-description",
      ])
      .stdout()
  }
}
