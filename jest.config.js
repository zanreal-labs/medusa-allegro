const { loadEnv } = require("@medusajs/framework/utils");

loadEnv("test", process.cwd());

module.exports = {
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  testEnvironment: "node",
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { decorators: true, syntax: "typescript" },
          target: "es2021",
        },
      },
    ],
  },
};

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  // `!(*.unit)` matters: module services have unit specs in the same
  // `__tests__` directory as their integration specs, and the stock Medusa
  // pattern (`**/*.[jt]s`) swept them into the integration run too. They would
  // then execute against a live Postgres they do not need, and every unit spec
  // would be reported twice.
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/!(*.unit).spec.[jt]s"];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];
}
