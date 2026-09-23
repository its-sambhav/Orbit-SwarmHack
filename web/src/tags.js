// Mirror of config/tags.yaml: the tag names the engine emits and the family
// each belongs to. Keep in step with that file - it is the source of truth
// (the API also serves it at /api/meta -> tag_registry).
export const TAGS = [
  { name: 'Delay in Sanction', family: 'timing' },
  { name: 'Recommendation Pending Sanction', family: 'timing' },
  { name: 'Sanctioned Work Not Taken Up', family: 'timing' },
  { name: 'Delay in Completion', family: 'timing' },
  { name: 'Work Not Completed', family: 'timing' },
  { name: 'Payment Without Completion', family: 'timing' },
  { name: 'Prolonged Delay Beyond Guideline', family: 'timing' },
  { name: 'Excess Expenditure', family: 'money' },
  { name: 'Sanction Exceeds Recommendation', family: 'money' },
  { name: 'Expenditure Without Sanction', family: 'money' },
  { name: 'Expenditure After Completion', family: 'money' },
  { name: 'Unusual Cost', family: 'money' },
  { name: 'Payment and Completion Mismatch', family: 'money' },
  { name: 'Duplicate Work', family: 'money' },
  { name: 'Same Work Recommended by Multiple MPs', family: 'money' },
  { name: 'Prohibited Work', family: 'guideline' },
  { name: 'Trust/Society Limit Exceeded', family: 'guideline' },
  { name: 'Allocation Limit Exceeded', family: 'guideline' },
  { name: 'SC/ST Earmark Shortfall', family: 'guideline' },
  { name: 'Unspent Balance', family: 'guideline' },
  { name: 'Concentration of Works in a Single Agency', family: 'concentration' },
  { name: 'Completion Evidence Not Attached', family: 'documentation' },
  { name: 'Record Date Discrepancy', family: 'data_integrity' },
  { name: 'Calamity Consent Discrepancy', family: 'documentation' },
]

export const TAG_NAMES = TAGS.map((t) => t.name)
export const TAG_FAMILY = Object.fromEntries(TAGS.map((t) => [t.name, t.family]))
