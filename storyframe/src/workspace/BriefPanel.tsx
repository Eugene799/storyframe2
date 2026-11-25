import type { BriefMode, ProjectBrief, VoicePreference } from "../../shared/project-contract";

interface BriefPanelProps {
  brief: ProjectBrief;
  onChange: (brief: ProjectBrief) => void;
}

export function BriefPanel({ brief, onChange }: BriefPanelProps) {
  function text(key: "topic" | "audience" | "goal" | "tone" | "preset", value: string) {
    onChange({ ...brief, [key]: value });
  }

  return (
    <section className="panel editor-panel" aria-labelledby="brief-heading">
      <div className="panel-heading">
        <h2 id="brief-heading">Brief</h2>
        <span className="status status-dev">One source of truth</span>
      </div>
      <p className="muted editor-intro">
        These answers shape the script and storyboard. Nothing here calls a model or spends the planning budget in
        Phase 4.
      </p>

      <div className="field-grid">
        <label className="field" htmlFor="brief-topic">
          <span className="field-label">Topic</span>
          <input
            id="brief-topic"
            value={brief.topic}
            maxLength={300}
            onChange={(event) => text("topic", event.target.value)}
            placeholder="What is this story about?"
          />
        </label>

        <label className="field" htmlFor="brief-audience">
          <span className="field-label">Audience</span>
          <input
            id="brief-audience"
            value={brief.audience}
            maxLength={300}
            onChange={(event) => text("audience", event.target.value)}
            placeholder="Who should understand or feel it?"
          />
        </label>

        <label className="field field-wide" htmlFor="brief-goal">
          <span className="field-label">Goal</span>
          <textarea
            id="brief-goal"
            rows={2}
            value={brief.goal}
            maxLength={500}
            onChange={(event) => text("goal", event.target.value)}
            placeholder="What should the viewer know, feel, or do?"
          />
        </label>

        <label className="field" htmlFor="brief-mode">
          <span className="field-label">Factual or fiction</span>
          <select
            id="brief-mode"
            value={brief.mode}
            onChange={(event) => onChange({ ...brief, mode: event.target.value as BriefMode })}
          >
            <option value="factual">Factual</option>
            <option value="fiction">Fiction</option>
          </select>
        </label>

        <label className="field" htmlFor="brief-duration">
          <span className="field-label">Target duration (seconds)</span>
          <input
            id="brief-duration"
            type="number"
            min={5}
            max={3600}
            step={1}
            value={brief.targetDurationSeconds}
            onChange={(event) =>
              onChange({
                ...brief,
                targetDurationSeconds: Math.max(5, Math.floor(event.target.valueAsNumber || 5)),
              })
            }
          />
        </label>

        <label className="field" htmlFor="brief-tone">
          <span className="field-label">Tone</span>
          <input
            id="brief-tone"
            value={brief.tone}
            maxLength={80}
            onChange={(event) => text("tone", event.target.value)}
          />
        </label>

        <label className="field" htmlFor="brief-preset">
          <span className="field-label">Format preset</span>
          <input
            id="brief-preset"
            value={brief.preset}
            maxLength={80}
            onChange={(event) => text("preset", event.target.value)}
          />
        </label>

        <label className="field" htmlFor="brief-voice">
          <span className="field-label">Voice preference</span>
          <select
            id="brief-voice"
            value={brief.voicePreference}
            onChange={(event) =>
              onChange({ ...brief, voicePreference: event.target.value as VoicePreference })
            }
          >
            <option value="warm">Warm</option>
            <option value="energetic">Energetic</option>
            <option value="neutral">Neutral</option>
            <option value="none">No narration</option>
          </select>
        </label>

        <label className="field" htmlFor="brief-budget">
          <span className="field-label">Planning budget (USD)</span>
          <input
            id="brief-budget"
            type="number"
            min={0}
            max={10000}
            step={0.5}
            value={brief.planningBudgetUsd}
            onChange={(event) =>
              onChange({
                ...brief,
                planningBudgetUsd: Math.max(0, event.target.valueAsNumber || 0),
              })
            }
          />
          <span className="hint">Recorded with the brief. No planning request is made in Phase 4.</span>
        </label>
      </div>
    </section>
  );
}
