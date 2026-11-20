import { expect, test } from "@playwright/test";
import type { RunEntry, RunSummary, ScenarioDetail } from "../src/lib/types";

const runs: RunEntry[] = ["one", "two"].map((id) => ({
  run_id: id, model_name: `Model ${id}`, timestamp: "2026-01-01", training_step: null,
  n_scenarios: 1, overall_pass_rate: 1, overall_avg_tool_score: 1,
}));

function summary(id: string): RunSummary {
  return {
    ...runs.find((run) => run.run_id === id)!,
    aggregates: { overall: { n: 1, pass_rate: 1, avg_tool_score: 1 }, by_category: {}, failure_types: {}, top_missing_tools: [] },
    scenarios: [{ scenario_id: "example", category: "fixture", passed: true, tool_score: 1,
      failure_type: "", n_tool_calls: 0, n_messages: 1, duration_s: 1, n_format_errors: 0,
      n_think_leaks: 0, tool_efficiency: 1, prompt_tokens: 1, completion_tokens: 1 }],
  };
}

function detail(id: string): ScenarioDetail {
  return {
    scenario_id: "example", task_prompt: "Fixture question", category: "fixture",
    model_answer: `Answer ${id}`, expected_answer: "Fixture answer", validation_decision: "correct", validation_rationale: "Fixture matches",
    conversation: [], per_tool: [], oracle_events: [],
    metrics: { tool_score: 1, total_tokens: 2, prompt_tokens: 1, completion_tokens: 1,
      duration_s: 1, tool_efficiency: 1, failure_type: "success" },
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/data/index.json", (route) => route.fulfill({ json: { runs } }));
  await page.route("**/data/runs/*/summary.json", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ json: summary(id) });
  });
  await page.route("**/api/detail/*/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ json: detail(id) });
  });
});

for (const path of ["/", "/scenarios"]) {
  test(`${path} handles changing the selected run`, async ({ page }) => {
    await page.goto(path);
    const selector = page.getByRole("combobox").first();
    await expect(selector).toHaveValue("one");
    await selector.selectOption("two");
    await expect(selector).toHaveValue("two");
    await expect(page.getByText("Failed to load", { exact: true })).toHaveCount(0);
    await expect(page.getByText(path === "/" ? "Scenarios" : "example", { exact: true }).last()).toBeVisible();
  });
}

test("scenario details handle no run and a selected run", async ({ page }) => {
  await page.goto("/scenarios/example");
  await expect(page.getByText("No run selected", { exact: true })).toBeVisible();
  await page.goto("/scenarios/example?run=one");
  await expect(page.getByText("Answer one", { exact: true })).toBeVisible();
});

test("comparison clears details when the selection is cleared", async ({ page }) => {
  await page.goto("/compare");
  const selector = page.getByRole("combobox").last();
  await expect(selector.locator("option[value='example']")).toHaveCount(1);
  await selector.selectOption("example");
  await expect(page.getByText("Answer one", { exact: true })).toBeVisible();
  await selector.selectOption("");
  await expect(page.getByText("Answer one", { exact: true })).toHaveCount(0);
});

test("a late summary cannot replace the newly selected run", async ({ page }) => {
  let release = () => {};
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/data/runs/one/summary.json", async (route) => {
    await delayed;
    await route.fulfill({ json: summary("one") });
  });
  await page.route("**/data/runs/two/summary.json", (route) => {
    const value = summary("two");
    value.scenarios = [...value.scenarios, { ...value.scenarios[0], scenario_id: "other" }];
    return route.fulfill({ json: value });
  });
  try {
    await page.goto("/");
    const selector = page.getByRole("combobox").first();
    await expect(selector).toHaveValue("one");
    await selector.selectOption("two");
    const count = page.locator("p").filter({ hasText: /^Scenarios$/ }).locator("..").getByText("2", { exact: true });
    await expect(count).toBeVisible();
    const oldResponse = page.waitForResponse("**/data/runs/one/summary.json");
    release();
    await oldResponse;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(count).toBeVisible();
  } finally {
    release();
  }
});
