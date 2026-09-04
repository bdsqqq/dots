const phases = {
  collect: {
    kicker: "evidence boundary",
    schema: "nubank-statement-envelope@1",
    title: "Only the smallest useful input crosses in.",
    description:
      "Provider collection stays outside the ledger. Nubank statement CSV and bounded Wise notification envelopes enter manually, read-only.",
    file: "synthetic_statement.csv",
    grade: "grade · direct",
    labels: ["date", "reference", "amount"],
    rows: [
      ["12/08/2026", "ACME STUDIO · INV-104", "+ 8.500,00"],
      ["13/08/2026", "HOSTING CO · AUG", "− 219,00"],
      ["…", "content remains private", "…"],
    ],
  },
  normalize: {
    kicker: "schema boundary",
    schema: "transaction-candidate@1",
    title: "Provider syntax becomes explicit facts.",
    description:
      "Dates, direction, status, identifiers, and amounts become exact versioned records. Money is always a positive safe integer plus a native ISO currency.",
    file: "candidate / txn_8bd4",
    grade: "schema · exact",
    labels: ["field", "value", "result"],
    rows: [
      ["bookedOn", "2026-08-12", "valid"],
      ["money", "BRL · 850000 minor units", "valid"],
      ["direction", "incoming · completed", "valid"],
    ],
  },
  deduplicate: {
    kicker: "identity boundary",
    schema: "ingest-result@1",
    title: "The same evidence produces the same identity.",
    description:
      "Provider transaction IDs lead when present. Stable source positions and content digests provide deterministic fallback identity without relying on mutable labels.",
    file: "replay / revision 7f4c…91aa",
    grade: "cas · unchanged",
    labels: ["outcome", "count", "result"],
    rows: [
      ["inserted", "0", "—"],
      ["duplicate", "4", "matched"],
      ["conflict", "0", "—"],
    ],
  },
  classify: {
    kicker: "policy boundary",
    schema: "classification@1",
    title: "Ambiguity is a result, not an invitation to guess.",
    description:
      "Revenue, expense, owner funding, cashback, and internal transfer are explicit outcomes with confidence and basis. Anything else remains unresolved.",
    file: "classification / synthetic",
    grade: "confidence · confirmed",
    labels: ["reference", "classification", "confidence"],
    rows: [
      ["INV-104", "revenue", "confirmed"],
      ["AUG", "expense", "confirmed"],
      ["UNKNOWN", "unclassified", "tentative"],
    ],
  },
  report: {
    kicker: "report boundary",
    schema: "report@1",
    title: "Totals say exactly what they include.",
    description:
      "Reports are deterministic and partitioned by native currency. Failed and cancelled movements remain visible as diagnostics but never enter completed totals.",
    file: "inclusive interval / 2026-Q3",
    grade: "native · no fx",
    labels: ["currency", "membership", "amount"],
    rows: [
      ["BRL", "3 classified incoming", "18.400,00"],
      ["EUR", "1 classified incoming", "2.400,00"],
      ["excluded", "failed / cancelled", "2"],
    ],
  },
};

const currencies = {
  BRL: {
    receipt: "R$ 18.400,00",
    caption: "3 completed movements",
    revenue: "R$ 15.000,00",
    funding: "R$ 3.000,00",
    cashback: "R$ 400,00",
    excluded: "2 excluded",
  },
  EUR: {
    receipt: "€ 2.400,00",
    caption: "1 completed movement",
    revenue: "€ 2.400,00",
    funding: "€ 0,00",
    cashback: "€ 0,00",
    excluded: "0 excluded",
  },
};

const phaseKicker = document.querySelector("#phase-kicker");
const phaseSchema = document.querySelector("#phase-schema");
const phaseTitle = document.querySelector("#phase-title");
const phaseDescription = document.querySelector("#phase-description");
const phaseVisual = document.querySelector("#phase-visual");

function phaseMarkup(phase) {
  const rows = phase.rows
    .map(
      (row, index) =>
        `<div class="evidence-row${index === phase.rows.length - 1 ? " muted" : ""}">${row
          .map((value) => `<span>${value}</span>`)
          .join("")}</div>`,
    )
    .join("");
  return `<div class="evidence-head"><span>${phase.file}</span><span class="grade">${phase.grade}</span></div>
    <div class="evidence-row labels">${phase.labels.map((label) => `<span>${label}</span>`).join("")}</div>${rows}`;
}

for (const button of document.querySelectorAll(".phase")) {
  button.addEventListener("click", () => {
    const phase = phases[button.dataset.phase];
    for (const candidate of document.querySelectorAll(".phase")) {
      const active = candidate === button;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    }
    phaseKicker.textContent = phase.kicker;
    phaseSchema.textContent = phase.schema;
    phaseTitle.textContent = phase.title;
    phaseDescription.textContent = phase.description;
    phaseVisual.innerHTML = phaseMarkup(phase);
  });
}

for (const tab of document.querySelectorAll("[data-currency]")) {
  function selectCurrency() {
    const currency = currencies[tab.dataset.currency];
    for (const candidate of document.querySelectorAll("[data-currency]")) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }
    document.querySelector("#currency-report").setAttribute("aria-labelledby", tab.id);
    document.querySelector("#receipt-total").textContent = currency.receipt;
    document.querySelector("#receipt-caption").textContent = currency.caption;
    document.querySelector("#revenue-total").textContent = currency.revenue;
    document.querySelector("#funding-total").textContent = currency.funding;
    document.querySelector("#cashback-total").textContent = currency.cashback;
    document.querySelector("#excluded-total").textContent = currency.excluded;
  }

  tab.addEventListener("click", selectCurrency);
  tab.addEventListener("keydown", (event) => {
    const tabs = [...document.querySelectorAll("[data-currency]")];
    const current = tabs.indexOf(tab);
    const target =
      event.key === "ArrowRight" ? tabs[(current + 1) % tabs.length]
      : event.key === "ArrowLeft" ? tabs[(current - 1 + tabs.length) % tabs.length]
      : event.key === "Home" ? tabs[0]
      : event.key === "End" ? tabs.at(-1)
      : null;
    if (!target) return;
    event.preventDefault();
    target.click();
    target.focus();
  });
}

const runButton = document.querySelector("#run-button");
const runLabel = document.querySelector("#run-label");
const runSummary = document.querySelector("#run-summary");
let replay = false;

runButton.addEventListener("click", () => {
  if (replay) {
    runSummary.innerHTML = "<strong>replay complete</strong> inserted 0 · duplicate 4 · conflict 0";
  } else {
    runSummary.innerHTML = "<strong>ingest complete</strong> inserted 4 · quarantined 1 · conflict 0";
    runLabel.textContent = "replay identical evidence";
    replay = true;
  }
});
