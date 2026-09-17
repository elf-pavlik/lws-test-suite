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

  private touchstoneSource(source?: Directory): Directory {
    return source ?? dag.git("https://github.com/ebremer/touchstone").head().tree()
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
   * accepts anonymous requests without configuration. It listens on port 8080;
   * lws.base-uri is set to the service hostname (see below).
   *
   * The source defaults to a clone of https://github.com/ebremer/lws-server;
   * pass --source with a local checkout to test uncommitted changes.
   *
   * Bind it from another container with withServiceBinding("lws-server", svc)
   * or expose it to the host with `dagger call lws-server ... up --ports 8080:8080`.
   *
   * lws.base-uri is set to the service hostname so every IRI the server mints
   * (storage description, resources, DPoP htu) is resolvable by clients bound
   * to it inside the test network.
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
          "-Dlws.base-uri=http://lws-server:8080",
          "-jar",
          "target/lws-server.jar",
        ],
      })
      .withHostname("lws-server")
  }

  /**
   * Builds the Touchstone conformance harness image, following the same recipe
   * as its Dockerfile: Maven-wrapper build on JDK 21, then a slim JRE runtime
   * carrying the shaded CLI jar plus the catalog and manifests.
   */
  private touchstoneImage(source?: Directory): Container {
    const src = this.touchstoneSource(source)
    const build = dag
      .container()
      .from("eclipse-temurin:21-jdk")
      .withMountedCache("/root/.m2", dag.cacheVolume("touchstone-m2"))
      .withDirectory("/src", src)
      .withWorkdir("/src")
      .withExec([
        "sh", "./mvnw", "-q", "-B", "-ntp",
        "-pl", "harness-cli", "-am",
        "-Dmaven.test.skip=true", "package",
      ])
    return dag
      .container()
      .from("eclipse-temurin:21-jre")
      .withWorkdir("/opt/touchstone")
      .withFile("touchstone.jar", build.file("/src/harness-cli/target/touchstone.jar"))
      .withDirectory("catalog", src.directory("catalog"))
      .withDirectory("manifests", src.directory("manifests"))
  }

  /**
   * Starts the lws-server bound as "lws-server" and runs the Touchstone
   * conformance harness (https://github.com/ebremer/touchstone) against it as
   * the test harness.
   *
   * The harness container registers the lws-server service as the SUT target
   * in a targets.yaml registry (Touchstone only accepts target ids, never raw
   * URLs) and runs the core module. Reports land in a touchstone-runs cache
   * volume under /work/runs. Exit codes are preserved: 0 conformant, 1
   * non-conformant (fails the run), 2 harness misconfiguration.
   */
  @func()
  async test(source?: Directory, touchstone?: Directory): Promise<string> {
    const server = this.lwsServer(source)
    return this.touchstoneImage(touchstone)
      .withServiceBinding("lws-server", server)
      .withNewFile(
        "/work/targets.yaml",
        "targets:\n" +
          "  sut:\n" +
          "    baseUrl: http://lws-server:8080/\n" +
          "    adapter: env\n",
      )
      .withMountedCache("/work/runs", dag.cacheVolume("touchstone-runs"))
      .withExec([
        "java", "-jar", "/opt/touchstone/touchstone.jar",
        "run",
        "--target", "sut",
        "--module", "core",
        "--targets", "/work/targets.yaml",
        "--report-dir", "/work/runs",
        "--catalog", "catalog",
        "--manifests", "manifests",
      ])
      .stdout()
  }
}
