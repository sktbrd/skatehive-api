import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // HAFSQL_Database's constructor connects eagerly at module load time
      // (route files do `const hafDb = new HAFSQL_Database()` at the top
      // level), so these need to exist before any route module is imported,
      // even in tests that mock executeQuery and never open a real socket.
      HAFSQL_USER: "test",
      HAFSQL_PWD: "test",
      HAFSQL_SERVER: "localhost",
      HAFSQL_DATABASE: "test",
    },
  },
});
