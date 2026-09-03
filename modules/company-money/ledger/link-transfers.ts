import { calendarDayDistance, compareCodeUnits } from "../money.ts";
import type { TransactionV1, TransferLinkV1 } from "./state.ts";

export interface TransferLinkIdentity {
  digest(namespace: string, parts: readonly string[]): string;
}

export interface TransferReconciliationPolicy {
  isEligibleAccountPair(outgoingAlias: string, incomingAlias: string): boolean;
}

export interface TransferReconciliationResult {
  readonly links: readonly TransferLinkV1[];
  readonly ambiguousTransactionCount: number;
}

function isConfirmedTransfer(transaction: TransactionV1): boolean {
  return (
    transaction.status === "completed" &&
    transaction.classification.value === "internal-transfer" &&
    transaction.classification.confidence === "confirmed"
  );
}

export function reconcileTransferLinks(
  transactions: readonly TransactionV1[],
  policy: TransferReconciliationPolicy,
  identity: TransferLinkIdentity,
): TransferReconciliationResult {
  const outgoing = transactions
    .filter((transaction) => isConfirmedTransfer(transaction) && transaction.direction === "outgoing")
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const incoming = transactions
    .filter((transaction) => isConfirmedTransfer(transaction) && transaction.direction === "incoming")
    .sort((left, right) => compareCodeUnits(left.id, right.id));

  const outgoingEdges = new Map<string, string[]>();
  const incomingEdges = new Map<string, string[]>();
  for (const source of outgoing) {
    for (const destination of incoming) {
      if (
        source.accountAlias === destination.accountAlias ||
        !policy.isEligibleAccountPair(source.accountAlias, destination.accountAlias) ||
        source.money.currency !== destination.money.currency ||
        source.money.minorUnits !== destination.money.minorUnits ||
        calendarDayDistance(source.bookedOn, destination.bookedOn) > 3
      ) {
        continue;
      }
      outgoingEdges.set(source.id, [...(outgoingEdges.get(source.id) ?? []), destination.id]);
      incomingEdges.set(destination.id, [...(incomingEdges.get(destination.id) ?? []), source.id]);
    }
  }

  const links: TransferLinkV1[] = [];
  const linked = new Set<string>();
  for (const source of outgoing) {
    const destinations = outgoingEdges.get(source.id) ?? [];
    if (destinations.length !== 1) continue;
    const destinationId = destinations[0];
    if ((incomingEdges.get(destinationId) ?? []).length !== 1) continue;
    linked.add(source.id);
    linked.add(destinationId);
    links.push({
      kind: "company-money.transfer-link",
      version: 1,
      id: identity.digest("company-money/transfer-link/v1", [source.id, destinationId]),
      outgoingTransactionId: source.id,
      incomingTransactionId: destinationId,
      reconciliationRuleVersion: 1,
    });
  }
  links.sort((left, right) => compareCodeUnits(left.id, right.id));

  const candidateIds = new Set([...outgoingEdges.keys(), ...incomingEdges.keys()]);
  return {
    links,
    ambiguousTransactionCount: [...candidateIds].filter((id) => !linked.has(id)).length,
  };
}
