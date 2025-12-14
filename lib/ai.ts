const BASE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

type MonthLabel = `${typeof BASE_MONTHS[number]} ${number}`

interface ForecastSeed {
  disease: string
  lga: string
  horizon: number
  scenario: "baseline" | "rainfall_shock" | "supply_boost" | "community_outreach"
  lastActual?: number
}

export interface ForecastPoint {
  month: MonthLabel
  actual: number | null
  forecast: number
  lower: number
  upper: number
  confidence: number
}

const diseaseProfiles: Record<
  string,
  {
    baseRate: number
    volatility: number
    seasonalStrength: number
    floor: number
  }
> = {
  malaria: { baseRate: 520, volatility: 0.18, seasonalStrength: 0.22, floor: 120 },
  typhoid: { baseRate: 110, volatility: 0.12, seasonalStrength: 0.15, floor: 20 },
  diarrhea: { baseRate: 150, volatility: 0.1, seasonalStrength: 0.18, floor: 30 },
  rti: { baseRate: 210, volatility: 0.14, seasonalStrength: 0.2, floor: 40 },
}

const lgaModifiers: Record<string, number> = {
  OWO: 1,
  "AKURE SOUTH": 1.08,
  "AKURE NORTH": 0.94,
  "AKOKO N E": 0.9,
  "AKOKO S E": 1.02,
  "AKOKO S W": 0.98,
  "ODIGBO": 1.12,
  default: 1,
}

function pseudoRandom(seed: string) {
  let value = 0
  for (let i = 0; i < seed.length; i++) {
    value = (value << 5) - value + seed.charCodeAt(i)
    value |= 0
  }

  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296
    return Math.abs(value) / 4294967296
  }
}

function seasonalWeight(index: number, strength: number) {
  const radians = ((index % 12) / 12) * Math.PI * 2
  return 1 + Math.sin(radians) * strength
}

export function generateForecast(seed: ForecastSeed): ForecastPoint[] {
  const profile = diseaseProfiles[seed.disease] ?? diseaseProfiles.malaria
  const modifier = lgaModifiers[seed.lga.toUpperCase()] ?? lgaModifiers.default
  const getRandom = pseudoRandom(`${seed.disease}-${seed.lga}-${seed.scenario}`)
  const scenarioShift =
    seed.scenario === "rainfall_shock"
      ? 1.12
      : seed.scenario === "supply_boost"
        ? 0.92
        : seed.scenario === "community_outreach"
          ? 0.96
          : 1

  const horizon = Math.max(seed.horizon, 6)
  const baseline = seed.lastActual ?? profile.baseRate * modifier

  const points: ForecastPoint[] = []

  for (let i = 0; i < horizon; i++) {
    const seasonal = seasonalWeight(i, profile.seasonalStrength)
    const drift = 1 + (getRandom() - 0.45) * profile.volatility
    const projected = Math.max(profile.floor, baseline * seasonal * drift * scenarioShift)

    const confidence = Math.round(78 + getRandom() * 18)
    const band = projected * 0.12

    const monthIndex = new Date().getMonth() + i
    const year = new Date().getFullYear() + Math.floor((new Date().getMonth() + i) / 12)
    const month = BASE_MONTHS[monthIndex % 12]

    points.push({
      month: `${month} ${year}` as MonthLabel,
      actual: i === 0 ? baseline : null,
      forecast: Math.round(projected),
      lower: Math.round(projected - band),
      upper: Math.round(projected + band),
      confidence,
    })
  }

  return points
}

export interface FacilityLoadPoint {
  facility: string
  current: number
  forecast: number
  capacity: number
  utilization: number
}

export function forecastFacilityLoads(
  disease: string,
  scenario: ForecastSeed["scenario"],
): FacilityLoadPoint[] {
  const facilities = [
    { facility: "PHC IPELE", capacity: 1500, base: 0.94 },
    { facility: "PHC OKEDOGBON", capacity: 1200, base: 0.78 },
    { facility: "PHC OKOJA", capacity: 1400, base: 0.9 },
    { facility: "PHC ISUA", capacity: 1000, base: 0.7 },
  ]

  const scenarioMultiplier =
    disease === "malaria"
      ? scenario === "rainfall_shock"
        ? 1.18
        : 1
      : 1

  return facilities.map((item, index) => {
    const getRandom = pseudoRandom(`${item.facility}-${disease}-${scenario}`)
    const drift = 0.9 + getRandom() * 0.25
    const current = Math.round(item.capacity * item.base * drift)
    const forecast = Math.round(current * (1.05 + index * 0.02) * scenarioMultiplier)
    return {
      ...item,
      current,
      forecast,
      utilization: Math.min(100, Math.round((forecast / item.capacity) * 100)),
    }
  })
}

export interface ScenarioAdjustment {
  bedExpansion: number
  communityOutreach: number
  stockBoost: number
}

export function runScenarioSimulation(
  baseline: ForecastPoint[],
  adjustments: ScenarioAdjustment,
): ForecastPoint[] {
  const outreachModifier = 1 - adjustments.communityOutreach * 0.04
  const stockModifier = 1 - adjustments.stockBoost * 0.03
  const capacityModifier = 1 + adjustments.bedExpansion * 0.05

  return baseline.map((point, index) => {
    const combinedModifier = outreachModifier * stockModifier * (index === 0 ? 1 : capacityModifier)
    const adjustedForecast = Math.round(point.forecast * combinedModifier)
    const adjustedBand = Math.round((point.upper - point.lower) / 2)

    return {
      ...point,
      forecast: adjustedForecast,
      lower: Math.max(point.lower - adjustedBand * adjustments.bedExpansion, point.lower * 0.85),
      upper: Math.max(point.upper * 0.92, adjustedForecast + adjustedBand),
    }
  })
}

export interface PatientTriageInput {
  age: number
  gender: "male" | "female" | "other"
  pregnancyStatus?: "pregnant" | "postpartum" | "not_applicable"
  symptoms: string
  vitals: {
    temperature: number
    heartRate: number
    respiratoryRate: number
    systolicBP: number
    diastolicBP: number
    spo2: number
  }
  onsetHours: number
  comorbidities: string[]
}

export interface PatientTriageResult {
  primaryCondition: string
  severity: "emergency" | "urgent" | "routine"
  confidence: number
  matchedSymptoms: string[]
  redFlags: string[]
  carePlan: string[]
  referral: {
    needed: boolean
    facility: string
    reason: string
  }
  medications: { name: string; dosage: string; duration: string }[]
  monitoring: string[]
  differentials: { condition: string; likelihood: number }[]
  narrative: string
}

const triageKnowledgeBase = [
  {
    name: "Severe Malaria",
    keywords: ["fever", "chills", "headache", "vomiting", "weakness"],
    thresholds: {
      temperature: 38.5,
      heartRate: 110,
    },
    severity: "urgent" as const,
    carePlan: [
      "Perform malaria RDT and thick blood smear",
      "Start ACT regimen immediately if positive",
      "Administer paracetamol for fever management",
      "Assess hydration status every 4 hours",
    ],
    referral: {
      needed: false,
      facility: "Closest PHC with microscopy",
      reason: "Manageable with PHC resources if patient stable",
    },
    medications: [
      { name: "Artemether-Lumefantrine", dosage: "Adult dose: 4 tablets twice daily", duration: "3 days" },
      { name: "Paracetamol", dosage: "500mg every 6 hours as needed", duration: "48 hours" },
    ],
  },
  {
    name: "Severe Pneumonia",
    keywords: ["cough", "breath", "chest", "fast breathing", "wheezing"],
    thresholds: {
      respiratoryRate: 30,
      spo2: 94,
    },
    severity: "emergency" as const,
    carePlan: [
      "Provide oxygen therapy if SpO2 < 92%",
      "Administer broad spectrum antibiotics",
      "Assess for danger signs (cyanosis, altered consciousness)",
      "Refer for chest X-ray and further management",
    ],
    referral: {
      needed: true,
      facility: "General Hospital Owo",
      reason: "Requires oxygen and imaging not available at PHC",
    },
    medications: [
      { name: "Ceftriaxone", dosage: "1g IV once daily", duration: "5-7 days" },
      { name: "Azithromycin", dosage: "500mg once daily", duration: "3 days" },
    ],
  },
  {
    name: "Acute Gastroenteritis",
    keywords: ["diarrhea", "stool", "vomiting", "abdominal"],
    thresholds: {
      heartRate: 100,
    },
    severity: "routine" as const,
    carePlan: [
      "Initiate oral rehydration therapy",
      "Assess dehydration using WHO scale",
      "Provide zinc supplementation for under-five",
      "Educate caregiver on hygiene and feeding",
    ],
    referral: {
      needed: false,
      facility: "PHC IPELE",
      reason: "Manage dehydration and monitor response",
    },
    medications: [
      { name: "Oral Rehydration Salts", dosage: "1 sachet in 1L water, sip frequently", duration: "Until rehydrated" },
      { name: "Zinc Sulfate", dosage: "20mg once daily", duration: "10-14 days" },
    ],
  },
  {
    name: "Hypertensive Emergency",
    keywords: ["headache", "vision", "pregnancy", "swelling"],
    thresholds: {
      systolicBP: 180,
      diastolicBP: 120,
    },
    severity: "emergency" as const,
    carePlan: [
      "Lower blood pressure gradually",
      "Monitor for neurological deficits",
      "Check urine protein if pregnant",
      "Prepare for immediate referral",
    ],
    referral: {
      needed: true,
      facility: "State Specialist Hospital Akure",
      reason: "Requires IV antihypertensives and continuous monitoring",
    },
    medications: [
      { name: "Labetalol", dosage: "20mg IV over 2 minutes", duration: "Single dose, repeat as necessary" },
      { name: "Hydralazine", dosage: "10mg IV over 2 minutes", duration: "As needed" },
    ],
  },
]

function symptomScore(symptomText: string, keywords: string[]) {
  const words = symptomText.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  const set = new Set(words)
  let score = 0

  keywords.forEach((keyword) => {
    if (keyword.includes(" ")) {
      if (symptomText.toLowerCase().includes(keyword)) score += 2
      return
    }

    if (set.has(keyword)) score += 1
  })

  return score
}

function evaluateSeverity(
  baseSeverity: PatientTriageResult["severity"],
  vitals: PatientTriageInput["vitals"],
  thresholds: Partial<Record<keyof PatientTriageInput["vitals"], number>>,
): PatientTriageResult["severity"] {
  let severity = baseSeverity

  if (thresholds.temperature && vitals.temperature >= thresholds.temperature + 1) severity = "urgent"
  if (thresholds.heartRate && vitals.heartRate >= thresholds.heartRate + 10) severity = "urgent"
  if (thresholds.respiratoryRate && vitals.respiratoryRate >= thresholds.respiratoryRate + 5) severity = "emergency"
  if (thresholds.spo2 && vitals.spo2 <= thresholds.spo2 - 2) severity = "emergency"
  if (thresholds.systolicBP && vitals.systolicBP >= thresholds.systolicBP) severity = "emergency"
  if (thresholds.diastolicBP && vitals.diastolicBP >= thresholds.diastolicBP) severity = "emergency"

  return severity
}

export function triagePatient(input: PatientTriageInput): PatientTriageResult {
  const scores = triageKnowledgeBase.map((entry) => {
    const score = symptomScore(input.symptoms, entry.keywords)
    return {
      entry,
      score,
      severity: evaluateSeverity(entry.severity, input.vitals, entry.thresholds),
    }
  })

  scores.sort((a, b) => b.score - a.score)

  const primary = scores[0]
  const baseConfidence = Math.min(95, 60 + primary.score * 8)
  const redFlags: string[] = []

  if (input.vitals.spo2 <= 92) redFlags.push("Low oxygen saturation")
  if (input.vitals.systolicBP >= 180) redFlags.push("Hypertensive crisis suspected")
  if (input.vitals.temperature >= 39.5) redFlags.push("High fever")
  if (input.onsetHours <= 24 && primary.score >= 3) redFlags.push("Rapid symptom onset")

  if (input.pregnancyStatus === "pregnant" && primary.entry.name !== "Hypertensive Emergency") {
    redFlags.push("Pregnancy - monitor for obstetric complications")
  }

  const matchedKeywords = primary.entry.keywords.filter((keyword) => input.symptoms.toLowerCase().includes(keyword))
  const differentials = scores.slice(1, 4).map(({ entry, score }) => ({
    condition: entry.name,
    likelihood: Math.max(10, Math.min(70, score * 12)),
  }))

  const narrativeParts = [
    `Patient presents with ${matchedKeywords.length ? matchedKeywords.join(", ") : "non-specific"} symptoms and vitals (Temp ${input.vitals.temperature}°C, HR ${input.vitals.heartRate} bpm, RR ${input.vitals.respiratoryRate}/min).`,
  ]

  if (redFlags.length) {
    narrativeParts.push(`Detected red flags: ${redFlags.join(", ")}.`)
  }

  narrativeParts.push(
    `Primary AI impression is ${primary.entry.name} with ${baseConfidence}% confidence, severity categorised as ${primary.severity}.`
  )

  if (primary.entry.referral.needed) {
    narrativeParts.push(`Immediate referral recommended to ${primary.entry.referral.facility}.`)
  } else {
    narrativeParts.push("Condition can be stabilised at primary care with close monitoring.")
  }

  return {
    primaryCondition: primary.entry.name,
    severity: primary.severity,
    confidence: baseConfidence,
    matchedSymptoms: matchedKeywords,
    redFlags,
    carePlan: primary.entry.carePlan,
    referral: primary.entry.referral,
    medications: primary.entry.medications,
    monitoring: [
      "Repeat vitals every 30 minutes until stable",
      "Document changes in symptom severity",
      "Escalate care if red flags worsen",
    ],
    differentials,
    narrative: narrativeParts.join(" "),
  }
}

export interface ParsedDataset {
  headers: string[]
  rows: Array<Record<string, number | string>>
}

export function parseDataset(text: string): ParsedDataset {
  const cleaned = text.trim()
  if (!cleaned) {
    return { headers: [], rows: [] }
  }

  const lines = cleaned.split(/\r?\n/).filter(Boolean)
  const headers = lines[0].split(",").map((h) => h.trim())

  const rows = lines.slice(1).map((line) => {
    const values = line.split(",").map((value) => value.trim())
    const record: Record<string, number | string> = {}
    headers.forEach((header, index) => {
      const numeric = Number(values[index])
      record[header] = Number.isFinite(numeric) ? numeric : values[index]
    })
    return record
  })

  return { headers, rows }
}

export interface DatasetInsight {
  metric: string
  value: string
  delta: string
  direction: "up" | "down" | "flat"
}

export interface DatasetAnalysis {
  insights: DatasetInsight[]
  lineSeries: Array<{ label: string; actual: number; forecast: number; month: string }>
  narrative: string
}

export function analyseDataset(
  dataset: ParsedDataset,
  disease: string,
  scenario: ForecastSeed["scenario"],
): DatasetAnalysis {
  if (!dataset.headers.length) {
    return {
      insights: [],
      lineSeries: [],
      narrative: "Provide a dataset to generate insights.",
    }
  }

  const monthKey = dataset.headers.find((header) => /month/i.test(header)) ?? dataset.headers[0]
  const malariaKey = dataset.headers.find((header) => /malaria/i.test(header)) ?? dataset.headers[1]
  const visitKey = dataset.headers.find((header) => /visit/i.test(header)) ?? dataset.headers[2]

  const numericRows = dataset.rows.filter((row) => typeof row[malariaKey] === "number")
  const totals = numericRows.reduce(
    (acc, row) => {
      acc.cases += Number(row[malariaKey])
      acc.visits += Number(row[visitKey] ?? 0)
      return acc
    },
    { cases: 0, visits: 0 },
  )

  const avgCases = numericRows.length ? totals.cases / numericRows.length : 0
  const lastActual = numericRows.length ? Number(numericRows[numericRows.length - 1][malariaKey]) : undefined

  const baselineForecast = generateForecast({
    disease,
    lga: "OWO",
    horizon: Math.max(6, numericRows.length + 3),
    scenario,
    lastActual,
  })

  const historySeries = numericRows.map((row, index) => ({
    month: String(row[monthKey]),
    actual: Number(row[malariaKey]) ?? 0,
    forecast: baselineForecast[index]?.forecast ?? 0,
    label: String(row[monthKey]),
  }))

  const futureSeries = baselineForecast.slice(numericRows.length, numericRows.length + 3).map((point) => ({
    month: point.month,
    actual: 0,
    forecast: point.forecast,
    label: point.month,
  }))

  const lineSeries = [...historySeries, ...futureSeries]

  const upcoming = baselineForecast.slice(numericRows.length, numericRows.length + 3)
  const nextQuarter = upcoming.reduce((acc, point) => acc + point.forecast, 0)

  const lastTwo = numericRows.slice(-2)
  const delta =
    lastTwo.length === 2
      ? ((Number(lastTwo[1][malariaKey]) - Number(lastTwo[0][malariaKey])) / Number(lastTwo[0][malariaKey] || 1)) * 100
      : 0

  const insights: DatasetInsight[] = [
    {
      metric: "Average Cases",
      value: Math.round(avgCases).toLocaleString(),
      delta: `${delta > 0 ? "+" : ""}${delta.toFixed(1)}% MoM`,
      direction: delta > 1 ? "up" : delta < -1 ? "down" : "flat",
    },
    {
      metric: "Total Visits",
      value: totals.visits.toLocaleString(),
      delta: `${Math.round(totals.visits / (numericRows.length || 1)).toLocaleString()} avg/month`,
      direction: "flat",
    },
    {
      metric: "Projected Next Quarter",
      value: Math.round(nextQuarter).toLocaleString(),
      delta: `${scenario.replace("_", " ")}`,
      direction: "up",
    },
  ]

  const narrative = `The uploaded dataset shows an average of ${Math.round(avgCases)} ${disease} cases per reporting period with a recent change of ${delta.toFixed(1)}%. The offline model projects ${Math.round(nextQuarter)} cases over the next quarter under the ${scenario.replace("_", " ")} scenario. Use these insights to pre-position staff and commodities accordingly.`

  return {
    insights,
    lineSeries,
    narrative,
  }
}
