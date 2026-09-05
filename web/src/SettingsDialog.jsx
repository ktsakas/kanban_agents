import React, { useEffect, useState } from 'react';
import { api } from './api.js';

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Minimal server-side directory browser, so the working dir can be picked. */
function DirPicker({ value, onPick, onClose }) {
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);

  const load = (path) =>
    api
      .dirs(path)
      .then((l) => {
        setListing(l);
        setError(null);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load(value);
  }, []);

  return (
    <div className="dirpicker">
      <div className="dirpicker-head">
        <code>{listing?.path ?? '...'}</code>
        <button className="btn" onClick={() => load(listing?.parent)}>
          Up
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            onPick(listing.path);
            onClose();
          }}
        >
          Use this folder
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && <p className="banner banner-error">{error}</p>}
      <div className="dirpicker-list">
        {listing?.entries.map((entry) => (
          <button key={entry.path} className="dirpicker-item" onClick={() => load(entry.path)}>
            {entry.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SettingsDialog({ settings, onClose, onSave }) {
  const [form, setForm] = useState(settings);
  const [picking, setPicking] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal">
        <header className="modal-head">
          <h3>Board settings</h3>
          <button className="icon-btn" onClick={onClose}>
            &times;
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span>Working directory</span>
            <div className="field-inline">
              <input value={form.workingDir} onChange={(e) => set({ workingDir: e.target.value })} />
              <button className="btn" onClick={() => setPicking((v) => !v)}>
                Browse
              </button>
            </div>
            <small>
              Every session runs here, sequentially, so each task builds on the previous one's
              changes.
            </small>
          </label>

          {picking && (
            <DirPicker
              value={form.workingDir}
              onPick={(p) => set({ workingDir: p })}
              onClose={() => setPicking(false)}
            />
          )}

          <div className="field-row">
            <label className="field">
              <span>Default model</span>
              <select className="select" value={form.model} onChange={(e) => set({ model: e.target.value })}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Default permissions</span>
              <select
                className="select"
                value={form.permissionMode}
                onChange={(e) => set({ permissionMode: e.target.value })}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Default effort</span>
              <select className="select" value={form.effort} onChange={(e) => set({ effort: e.target.value })}>
                {EFFORTS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>On success, move card to</span>
              <select
                className="select"
                value={form.autoAdvanceTo}
                onChange={(e) => set({ autoAdvanceTo: e.target.value })}
              >
                <option value="review">Review</option>
                <option value="done">Done</option>
              </select>
            </label>
            <label className="field">
              <span>Max turns per run (0 = unlimited)</span>
              <input
                type="number"
                min="0"
                value={form.maxTurns}
                onChange={(e) => set({ maxTurns: Number(e.target.value) })}
              />
            </label>
          </div>

          <label className="field field-check">
            <input
              type="checkbox"
              checked={form.pauseOnNeedsInput}
              onChange={(e) => set({ pauseOnNeedsInput: e.target.checked })}
            />
            <span>
              Hold the queue while any card is in Needs Input
              <small>
                Recommended. Otherwise the next task starts on a working tree that a blocked task
                left half-finished.
              </small>
            </span>
          </label>

          <label className="field">
            <span>Extra system prompt for every session</span>
            <textarea
              rows={4}
              placeholder="e.g. Always run the test suite before you finish."
              value={form.appendSystemPrompt}
              onChange={(e) => set({ appendSystemPrompt: e.target.value })}
            />
          </label>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onSave(form)}>
            Save
          </button>
        </footer>
      </div>
    </>
  );
}
