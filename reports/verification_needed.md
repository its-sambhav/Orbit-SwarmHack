# Values to confirm (`verified: false`)

Each of these came from the spec or was inferred from the data, and has not been checked against the 2023 MPLADS guidelines or another official document.

| Where | Value / source |
|---|---|
| detectors.yaml.guideline.sanction_days | 75 - June 2016 guidelines: sanction within 75 days of recommendation (45 days is the deadline to inform an MP of a rejection - the old config wrongly used 45 as the sanction deadline). Not yet confirmed against the 2023 guidelines. |
| detectors.yaml.guideline.completion_days | 365 - Guidelines para 3.13 - works completed within one year of sanction. Not confirmed against 2023 text. |
| detectors.yaml.delay_gate.mcc_adjustment | [['2019-03-10', '2019-05-26'], ['2024-03-16', '2024-06-06']] |
| detectors.yaml.detectors.PROHIBITED_WORK | ['\\b(?:construction\|renovation\|repair\|beautification\|development\|extension)\\s+of\\s+(?:the\\s+)?(?:temple\|mandir\|masjid\|mosque\|church\|gurudwara\|gurdwara\|dargah)\\b', '\\b(?:temple\|mandir\|masjid\|mosque\|church\|gurudwara\|gurdwara\|dargah)\\s+(?:premises\|campus\|compound)\\b', '\\b(?:acquisition of land\|land acquisition\|purchase of land)\\b'] |
| detectors.yaml.detectors.TRUST_SOCIETY_LIMIT_EXCEEDED.cap_per_mp_per_fy | 10000000 |
| detectors.yaml.detectors.ALLOCATION_LIMIT_EXCEEDED.inactive_rec_flags | [2] |
| detectors.yaml.detectors.CALAMITY_CONSENT_DISCREPANCY.max_consent_per_mp | 10000000 |
| tags.yaml.DELAY_IN_SANCTION | Delay in Sanction - source: MPLADS Guidelines para 3.12 (sanction within 75 days of recommendation) |
| tags.yaml.SANCTIONED_WORK_NOT_TAKEN_UP | Sanctioned Work Not Taken Up - source: CAG audit observation (sanctioned works not started); portal stage 'Time Estimation' / 'Vendor Identification' |
| tags.yaml.DELAY_IN_COMPLETION | Delay in Completion - source: MPLADS Guidelines para 3.13 (completion within one year of sanction) |
| tags.yaml.PROLONGED_DELAY_BEYOND_GUIDELINE | Prolonged Delay Beyond Guideline - source: MPLADS Guidelines paras 3.12-3.13 - fixed hard-breach limits, independent of how slow peers are |
| tags.yaml.EXCESS_EXPENDITURE | Excess Expenditure - source: CAG audit observation (expenditure in excess of sanctioned amount) |
| tags.yaml.SANCTION_EXCEEDS_RECOMMENDATION | Sanction Exceeds Recommendation - source: CAG audit observation (sanction without recommendation of the MP) |
| tags.yaml.PROHIBITED_WORK | Prohibited Work - source: MPLADS Guidelines Annexure-II (list of works not permissible) |
| tags.yaml.TRUST_SOCIETY_LIMIT_EXCEEDED | Trust/Society Limit Exceeded - source: MPLADS Guidelines para 3.21 (ceiling on works for trusts and societies) |
| tags.yaml.ALLOCATION_LIMIT_EXCEEDED | Allocation Limit Exceeded - source: Portal allocation table - recommendations above the MP's allocation for the tenure |
| tags.yaml.SC_ST_EARMARK_SHORTFALL | SC/ST Earmark Shortfall - source: MPLADS Guidelines para 2.5 (15% for SC areas, 7.5% for ST areas) - estimated |
| tags.yaml.UNSPENT_BALANCE | Unspent Balance - source: CAG audit observation (unspent MPLADS balance at end of tenure) |
| tags.yaml.CALAMITY_CONSENT_DISCREPANCY | Calamity Consent Discrepancy - source: Portal calamity consent table - event type and per-MP consent ceiling |
