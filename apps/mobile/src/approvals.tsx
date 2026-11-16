import { Play, RefreshCw, Send, ShieldCheck } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import type {
  ApprovalControl,
  ApprovalExecution,
  ApprovalRequest,
} from "../../../packages/domain/src/agent";
import {
  approvalCoversCurrent,
  canDiscuss,
  canExecute,
  currentExecution,
  currentVersion,
  executeApproval,
  fetchApproval,
  fetchApprovals,
  postApprovalMessage,
  sendApprovalControl,
  shortHash,
  staleApproval,
  visibleControls,
} from "./approval-state";
import { Button, Card, Chip, colors, dateLabel, Empty, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

// Approvals — the Owner Interaction Layer's persistent card + Talk to
// Arthur panel (spec §5–7). The card is a screen region, never a
// modal: the list, the card and the discussion all stay on screen
// together, and talking never dismisses or decides anything. Approval
// state changes only through the control buttons (which name the
// exact version they approve); the composer posts discussion only —
// see approval-state.ts for the structural path separation.

const STATUS_LABEL: Record<ApprovalRequest["status"], string> = {
  pending: "Waiting on you",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  stopped: "Stopped",
};
const STATUS_TINT: Record<ApprovalRequest["status"], string> = {
  pending: colors.orange,
  changes_requested: colors.lavender,
  approved: colors.green,
  rejected: colors.sky,
  stopped: colors.sky,
};
const CONTROL_LABEL: Record<ApprovalControl, string> = {
  approve_exact_version: "Approve",
  reject: "Reject",
  request_changes: "Request changes",
  keep_pending: "Keep pending",
  stop_operation: "Stop",
};

export function ApprovalsScreen() {
  const { api } = useWorkspace();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<{
    request: ApprovalRequest;
    executions: ApprovalExecution[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");

  const loadDetail = useCallback(
    async (id: string) => {
      const next = await fetchApproval(api, id);
      setDetail(next);
      // Keep the list row in step with the freshest copy of the card.
      setRequests((rows) => rows.map((row) => (row.id === id ? next.request : row)));
      return next;
    },
    [api],
  );

  const refresh = useCallback(async () => {
    setError("");
    try {
      const rows = await fetchApprovals(api);
      setRequests(rows);
      const keep =
        rows.find((row) => row.id === selectedId) ||
        rows.find((row) => row.status === "pending" || row.status === "changes_requested") ||
        rows[0];
      if (keep) {
        setSelectedId(keep.id);
        await loadDetail(keep.id);
      } else {
        setSelectedId("");
        setDetail(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, loadDetail, selectedId]);

  useEffect(() => {
    // Load once on mount; afterwards the Refresh button and every
    // mutation reload explicitly.
    void refresh();
  }, [api]);

  async function select(id: string) {
    setSelectedId(id);
    setBusy(true);
    setError("");
    try {
      await loadDetail(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // After any write, reload the card from the server: the copy on
  // screen is never trusted over the stored record (a revision may
  // have landed in between — the stale-version case).
  async function reloadAfterWrite(id: string) {
    try {
      await loadDetail(id);
      setRequests(await fetchApprovals(api));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function control(controlName: ApprovalControl) {
    if (!detail) return;
    const request = detail.request;
    const version = currentVersion(request);
    setBusy(true);
    setError("");
    try {
      await sendApprovalControl(
        api,
        request.id,
        controlName,
        controlName === "approve_exact_version" ? { version: version.version } : undefined,
      );
      await reloadAfterWrite(request.id);
    } catch (e) {
      // A 409 here usually means the version moved under the card
      // (revised after load): show the refusal and reload so the
      // owner decides on the version that actually exists now.
      setError(e instanceof Error ? e.message : String(e));
      await reloadAfterWrite(request.id);
    } finally {
      setBusy(false);
    }
  }

  async function runApproved() {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      await executeApproval(api, detail.request.id);
      await reloadAfterWrite(detail.request.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reloadAfterWrite(detail.request.id);
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    if (!detail || !draft.trim()) return;
    const text = draft.trim();
    setBusy(true);
    setError("");
    try {
      // Discussion only: this call reaches the messages route and
      // cannot change approval state, whatever the text says.
      await postApprovalMessage(api, detail.request.id, text);
      setDraft("");
      await reloadAfterWrite(detail.request.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const waiting = requests.filter(
    (row) => row.status === "pending" || row.status === "changes_requested",
  );

  return (
    <View style={{ gap: 20 }}>
      <View style={s.between}>
        <Text style={s.small}>
          {waiting.length ? `${waiting.length} waiting on your decision` : "Nothing waiting on you"}
        </Text>
        <Button small icon={RefreshCw} busy={busy && loading} onPress={() => void refresh()}>
          Refresh
        </Button>
      </View>
      <ErrorNotice error={error} />
      {loading ? (
        <ActivityIndicator color={colors.text} />
      ) : requests.length ? (
        <Card style={{ paddingVertical: 3 }}>
          {requests.map((row) => {
            const version = currentVersion(row);
            const selected = row.id === selectedId;
            return (
              <Pressable
                key={row.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => void select(row.id)}
                style={[
                  s.row,
                  {
                    gap: 12,
                    paddingVertical: 14,
                    borderTopWidth: 1,
                    borderTopColor: colors.line,
                    backgroundColor: selected ? colors.sky : undefined,
                  },
                ]}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={[s.text, { fontWeight: "600", fontSize: 14 }]}>{row.title}</Text>
                  <Text style={s.small}>
                    {version.action} · v{version.version} · updated {dateLabel(row.updatedAt)}
                  </Text>
                </View>
                <Chip tint={STATUS_TINT[row.status]}>{STATUS_LABEL[row.status]}</Chip>
              </Pressable>
            );
          })}
        </Card>
      ) : (
        <Empty
          icon={ShieldCheck}
          title="No approvals yet"
          detail="When Arthur needs your go-ahead for a merge, a deploy or another restricted action, the exact proposal will wait for you here."
        />
      )}
      {detail && (
        <ApprovalCard
          request={detail.request}
          executions={detail.executions}
          busy={busy}
          draft={draft}
          onDraftChange={setDraft}
          onControl={(name) => void control(name)}
          onExecute={() => void runApproved()}
          onSend={() => void sendMessage()}
        />
      )}
    </View>
  );
}

function ApprovalCard({
  request,
  executions,
  busy,
  draft,
  onDraftChange,
  onControl,
  onExecute,
  onSend,
}: {
  request: ApprovalRequest;
  executions: ApprovalExecution[];
  busy: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onControl: (control: ApprovalControl) => void;
  onExecute: () => void;
  onSend: () => void;
}) {
  const version = currentVersion(request);
  const stale = staleApproval(request);
  const covered = approvalCoversCurrent(request);
  const executed = currentExecution(request, executions);
  const controls = visibleControls(request);
  const discuss = canDiscuss(request);
  return (
    <Card style={{ gap: 13 }}>
      <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
        <Text style={[s.heading, { flex: 1 }]}>{request.title}</Text>
        <Chip tint={STATUS_TINT[request.status]}>{STATUS_LABEL[request.status]}</Chip>
      </View>
      <Text style={s.small}>
        Version {version.version} of {request.versions.length} · {version.action} · proposed by{" "}
        {version.createdBy} · {dateLabel(version.createdAt)} · hash {shortHash(version.contentHash)}
      </Text>
      {request.versions.length > 1 && (
        <Text style={[s.text, { fontSize: 13 }]}>
          Revised — this card shows the newest version (v{version.version}). Any approval of an
          earlier version no longer applies.
        </Text>
      )}
      {stale && (
        <Text style={[s.text, { fontSize: 13, color: colors.danger }]}>
          An approval of v{request.approvedVersion} is on record, but the proposal has moved to v
          {version.version} since — that approval does not cover this version.
        </Text>
      )}
      {request.status === "approved" && covered && !executed && (
        <Text style={[s.text, { fontSize: 13 }]}>
          You approved version {request.approvedVersion} exactly (hash{" "}
          {shortHash(request.approvedHash || "")}). It has not run yet.
        </Text>
      )}
      <View style={{ gap: 5 }}>
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>What would happen</Text>
        <Text style={[s.text, { fontSize: 14 }]}>{version.details}</Text>
      </View>
      {!!version.evidence && (
        <View style={{ gap: 5 }}>
          <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Evidence</Text>
          <Text style={[s.text, { fontSize: 14 }]}>{version.evidence}</Text>
        </View>
      )}
      {executed && (
        <View style={{ gap: 5 }}>
          <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Ran</Text>
          <Text style={[s.text, { fontSize: 14 }]}>
            v{executed.version} · {dateLabel(executed.at)} · {executed.result}
          </Text>
        </View>
      )}
      {!!controls.length && (
        <View style={[s.row, { gap: 9, flexWrap: "wrap" }]}>
          {controls.map((name) => (
            <Button
              key={name}
              small
              primary={name === "approve_exact_version"}
              danger={name === "reject" || name === "stop_operation"}
              busy={busy}
              onPress={() => onControl(name)}
            >
              {name === "approve_exact_version"
                ? `Approve exact version (v${version.version})`
                : CONTROL_LABEL[name]}
            </Button>
          ))}
          {canExecute(request, executions) && (
            <Button small primary icon={Play} busy={busy} onPress={onExecute}>
              Run approved v{version.version}
            </Button>
          )}
        </View>
      )}
      <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 14 }}>
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Talk to Arthur</Text>
        {request.discussion.length ? (
          request.discussion.map((message) => (
            <View key={`${message.at}|${message.from}|${message.text}`} style={{ gap: 2 }}>
              <Text style={s.small}>
                {message.from} · on v{message.version} · {dateLabel(message.at)}
              </Text>
              <Text style={[s.text, { fontSize: 14 }]}>{message.text}</Text>
            </View>
          ))
        ) : (
          <Text style={s.muted}>No discussion yet. Ask why, ask for evidence, or redirect.</Text>
        )}
        {discuss ? (
          <>
            <View
              style={[
                s.row,
                {
                  gap: 9,
                  backgroundColor: "#FFF",
                  borderWidth: 1,
                  borderColor: colors.line,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                },
              ]}
            >
              <TextInput
                accessibilityLabel="Message Arthur about this approval"
                placeholder="Ask, correct, or redirect — talking is not approving"
                placeholderTextColor={colors.muted}
                value={draft}
                onChangeText={onDraftChange}
                style={{ flex: 1, paddingVertical: 12, fontSize: 13, color: colors.text }}
              />
              <Button small icon={Send} busy={busy} onPress={onSend}>
                Send
              </Button>
            </View>
            <Text style={s.small}>
              A message here is discussion only — it never approves anything. Approval happens only
              with the Approve button above, for the exact version named on it.
            </Text>
          </>
        ) : (
          <Text style={s.small}>
            This request is {STATUS_LABEL[request.status].toLowerCase()} — its discussion is
            read-only now.
          </Text>
        )}
      </View>
    </Card>
  );
}
