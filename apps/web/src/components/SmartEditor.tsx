import type { Playlist, SmartRule, SmartRules } from "@hyperplayer/schemas";
import { useState } from "react";
import { api, call, errorMessage } from "../api.ts";
import { FIELDS, hint, MAX_LIMIT, opLabel, ops, ORDERS, rule } from "../player/smart.ts";
import "./smart.css";

/** A smart playlist's rules, edited in place and applied together, as in the Rust player. */
export function SmartEditor({
  playlist,
  onChanged,
  onSaveCopy,
}: {
  playlist: Playlist;
  onChanged: (p: Playlist) => void;
  onSaveCopy: () => void;
}) {
  const [rules, setRules] = useState<SmartRules>(playlist.rules!);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");

  const change = (f: (r: SmartRules) => SmartRules) => {
    setRules(f(rules));
    setDirty(true);
    setMessage("");
  };
  const setRule = (i: number, f: (r: SmartRule) => SmartRule) =>
    change((r) => ({ ...r, rules: r.rules.map((x, j) => (j === i ? f(x) : x)) }));

  const apply = () =>
    call(api.updatePlaylist, { params: { id: playlist.id }, body: { rules } })
      .then((p) => {
        setDirty(false);
        // The limit as applied, in case it was clamped.
        if (p.rules) setRules(p.rules);
        onChanged(p);
      })
      .catch((e: unknown) => setMessage(errorMessage(e)));

  return (
    <div className="smart">
      <div className="smart-line">
        <span>Tracks matching</span>
        <select
          value={rules.match}
          onChange={(e) => change((r) => ({ ...r, match: e.target.value as SmartRules["match"] }))}
        >
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        <span>of these rules:</span>
      </div>
      {rules.rules.length === 0 && <div className="faint">No rules: any track in the library.</div>}
      {rules.rules.map((r, i) => (
        <div key={i} className="smart-rule">
          <select
            value={r.field}
            onChange={(e) => {
              const field = e.target.value as SmartRule["field"];
              setRule(i, () => rule(field, ops(field)[0]!));
            }}
          >
            {FIELDS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={r.op}
            onChange={(e) => setRule(i, (x) => ({ ...x, op: e.target.value as SmartRule["op"] }))}
          >
            {ops(r.field).map((op) => (
              <option key={op} value={op}>
                {opLabel(r.field, op)}
              </option>
            ))}
          </select>
          {r.op !== "never" && (
            <input
              value={r.value}
              placeholder={hint(r.field)}
              maxLength={200}
              onChange={(e) => setRule(i, (x) => ({ ...x, value: e.target.value }))}
            />
          )}
          {r.op === "between" && (
            <>
              <span>and</span>
              <input
                value={r.value2}
                placeholder={hint(r.field)}
                maxLength={200}
                onChange={(e) => setRule(i, (x) => ({ ...x, value2: e.target.value }))}
              />
            </>
          )}
          <button
            className="icon-button"
            title="Remove this rule"
            onClick={() => change((x) => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="smart-line">
        <button
          className="outline-button"
          disabled={rules.rules.length >= 20}
          onClick={() => change((x) => ({ ...x, rules: [...x.rules, rule("title", "contains")] }))}
        >
          Add a rule
        </button>
      </div>
      <div className="smart-line">
        <span>Order by</span>
        <select
          value={rules.order}
          onChange={(e) => change((r) => ({ ...r, order: e.target.value as SmartRules["order"] }))}
        >
          {ORDERS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        {rules.order !== "random" && (
          <label className="check">
            <input
              type="checkbox"
              checked={rules.descending}
              onChange={(e) => change((r) => ({ ...r, descending: e.target.checked }))}
            />
            descending
          </label>
        )}
        <span>up to</span>
        <input
          className="smart-limit"
          type="number"
          min={1}
          max={MAX_LIMIT}
          value={rules.limit}
          onChange={(e) =>
            change((r) => ({ ...r, limit: Math.min(MAX_LIMIT, Math.max(1, Number(e.target.value) || 1)) }))
          }
        />
        <span>tracks</span>
      </div>
      <div className="smart-line">
        <button className="primary-button" disabled={!dirty} onClick={() => void apply()}>
          Apply
        </button>
        <button
          className="outline-button"
          onClick={onSaveCopy}
          title="An ordinary playlist with what matches now"
        >
          Save as playlist
        </button>
        {message && <span className="error">{message}</span>}
      </div>
    </div>
  );
}
