export function mergeTodayActionPlans(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("overview action entries must be an array");
  }
  const actionTargets = new Map();
  const today = [];
  for (const entry of entries) {
    const { analysis, scope, plan } = entry ?? {};
    if (!scope?.farmId || !scope?.cropId || !Array.isArray(plan?.today)) {
      throw new TypeError("overview action entry is incomplete");
    }
    for (const action of plan.today) {
      if (!action?.actionId) throw new TypeError("overview action id is required");
      if (actionTargets.has(action.actionId)) {
        throw new TypeError("overview action ids must be unique across crops");
      }
      actionTargets.set(action.actionId, { analysis, scope });
      today.push(action);
    }
  }
  today.sort((left, right) => String(left.dueAt).localeCompare(String(right.dueAt)));
  return {
    actionTargets,
    plan: {
      today,
      upcoming: [],
      firstAction: today.find((item) => item.status === "OPEN") ?? null,
    },
  };
}
