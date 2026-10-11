import React from 'react';

/**
 * Layout primitives shared by the configuration dialogs (model editor, OCR
 * source editor). Both forms are the same shape — identity, capabilities,
 * limits, cost, reasoning, routing, raw — so the grouping lives here instead
 * of being re-invented per dialog. All visuals are CSS classes
 * (`.form-section`, `.form-section-title`, `.form-label`, `.form-hint`) so
 * every theme applies at once.
 */

/** A titled group of fields; the title carries a hairline rule to its right. */
export const FormSection: React.FC<{ title: React.ReactNode; children: React.ReactNode }> = ({ title, children }) => (
  <div className="form-section">
    <div className="form-section-title">{title}</div>
    <div className="form-section-body">{children}</div>
  </div>
);

/** Label above a control, with an optional dim hint underneath. */
export const Field: React.FC<{ label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="form-label">{label}</label>
    {children}
    {hint ? <div className="form-hint">{hint}</div> : null}
  </div>
);

/** Evenly spaced row of fields (2-up for paired values, 4-up for cost). */
export const FieldRow: React.FC<{ columns?: number; children: React.ReactNode }> = ({ columns = 2, children }) => (
  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 10 }}>{children}</div>
);