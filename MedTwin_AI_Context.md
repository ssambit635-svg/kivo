# MedTwin AI -- Project Context File

## 1. Project Identity

**Project Name:** MedTwin AI\
**Tagline:** AI-Powered Digital Health Twin\
**Hackathon Track:** HealthTech\
**Hackathon:** iQOO Hackathon 2026\
**Current Stage:** Online Round\
**Primary Goal:** Build a compelling AI-first preventive-health
prototype for the iQOO HealthTech track.

------------------------------------------------------------------------

## 2. One-Line Product Definition

MedTwin AI is a preventive-health companion that turns a user's
scattered health reports and longitudinal health information into an
understandable, continuously updated digital health profile using OCR,
machine learning, explainable AI, and LLM-based reasoning.

------------------------------------------------------------------------

## 3. Problem Statement

Healthcare is often reactive. People may only seek medical attention
after symptoms appear or abnormal test results are discovered.

Blood reports contain medical terminology and numerical values that many
people find difficult to understand. Doctors also have limited
consultation time, making it difficult to explain every historical
report and gradual change.

Most existing health applications focus on fitness, wellness, or record
storage. General-purpose AI chatbots can answer health questions but
typically lack a structured, longitudinal understanding of a person's
medical history.

This creates several problems:

-   Users struggle to understand medical reports.
-   Historical reports are scattered and difficult to compare.
-   Gradual changes in health markers can be missed.
-   Users lack understandable explanations of possible risk factors.
-   Patients may arrive at doctor appointments without a clear summary
    of their health history.
-   Families may struggle to organize health information for multiple
    members.

MedTwin AI addresses this by creating a structured, longitudinal
representation of the user's health information.

------------------------------------------------------------------------

## 4. Target Users

### Primary Users

-   Adults who undergo periodic health check-ups.
-   People monitoring chronic-disease risk factors.
-   People who want to understand their laboratory reports.
-   Families managing health records for parents or grandparents.

### Example Risk Areas

The prototype may discuss risk awareness around areas such as:

-   Diabetes
-   Hypertension
-   Cardiovascular risk
-   Kidney-related risk

The system must clearly distinguish **risk awareness from diagnosis**.

------------------------------------------------------------------------

## 5. Core Product Concept: Digital Health Twin

The Digital Health Twin is a structured representation of a user's
health context.

It can contain:

-   Demographic information
-   Medical history
-   Family history
-   Laboratory results
-   Lifestyle information
-   Exercise/activity information
-   Sleep information
-   Nutrition information
-   Medication information where explicitly provided
-   Historical health measurements
-   User-entered observations

The twin is updated as new information is added.

### Important Principle

The Digital Health Twin is **not a medical diagnosis engine**.

It is a health-information and risk-awareness layer designed to help
users understand trends and prepare for better conversations with
healthcare professionals.

------------------------------------------------------------------------

## 6. Core Features

### 6.1 AI Blood Report Scanner

User uploads a blood/laboratory report.

Pipeline:

1.  Upload report image/PDF.
2.  OCR extracts text and values.
3.  AI identifies relevant laboratory parameters.
4.  Values are normalized into structured records.
5.  Units and reference ranges are preserved where available.
6.  User can review/correct extracted values.
7.  Data is added to the Digital Health Twin.

The system should avoid silently treating uncertain OCR output as fact.

------------------------------------------------------------------------

### 6.2 Simple Report Explanation

The system converts complex report terminology into understandable
explanations.

Example structure:

-   Test name
-   User's value
-   Reference range from the report/lab
-   Simple explanation
-   Historical context
-   Suggested discussion point for a doctor when appropriate

Avoid definitive statements such as:

> "You have diabetes."

Prefer language such as:

> "This value is outside the reference range shown on your report.
> Persistent abnormal results should be discussed with a qualified
> healthcare professional."

------------------------------------------------------------------------

### 6.3 Report-to-Report Trend Analysis

This is the primary USP.

Instead of analyzing one report in isolation, MedTwin compares multiple
reports over time.

Example:

``` text
Report 1 → Report 2 → Report 3 → Current Report
                 ↓
        Longitudinal Trend Engine
                 ↓
      Increasing / Stable / Decreasing
                 ↓
       Explainable Health Insight
```

The system should detect meaningful changes in available markers and
show them visually.

Possible UI:

-   Timeline
-   Trend charts
-   Percentage/absolute change
-   Reference-range context
-   "What changed?" summary
-   "Discuss with your doctor" flags

------------------------------------------------------------------------

## 7. Disease Risk Prediction

MedTwin may use machine-learning models trained/evaluated on appropriate
public healthcare datasets to estimate risk awareness for selected
conditions.

Potential model inputs may include:

-   Age
-   Relevant laboratory measurements
-   Blood pressure
-   BMI/body measurements when available
-   Lifestyle factors
-   Family history
-   Other model-supported features

### Critical Safety Rule

Predictions are **risk estimates, not diagnoses**.

The UI must explicitly communicate:

-   The result is not a medical diagnosis.
-   Model predictions have uncertainty.
-   Missing or inaccurate data can affect results.
-   Users should consult qualified healthcare professionals for medical
    decisions.

Do not claim clinical validation unless the specific model and evidence
actually support that claim.

------------------------------------------------------------------------

## 8. Explainable AI

A major feature is explaining why a risk estimate or insight was
generated.

Instead of:

> "Risk: 72%"

show something like:

``` text
Risk Awareness
      ↓
Major contributing factors
      ↓
• Factor A
• Factor B
• Factor C
      ↓
How each factor influenced the estimate
```

The explanation should distinguish:

-   Actual input data
-   Model-derived contribution/importance
-   LLM-generated natural-language explanation

The LLM must not invent medical evidence or fabricate reasons that were
not supported by the model/data.

------------------------------------------------------------------------

## 9. Health Simulation / "What If?"

The advanced version includes an AI-assisted health simulation
experience.

Example:

> "What if I improve my activity and sleep?"

The system can show a **scenario**, not a guaranteed medical outcome.

Possible flow:

``` text
Current profile
      ↓
User changes lifestyle variables
      ↓
Scenario/model calculation
      ↓
Projected direction/range
      ↓
Explanation + uncertainty
```

Important:

-   Do not promise that a lifestyle change will prevent or cure a
    disease.
-   Clearly label projections as estimates/scenarios.
-   Prefer ranges and uncertainty over fake precision.
-   The simulation should be based on an actual model or transparent
    calculation, not an LLM inventing numerical predictions.

------------------------------------------------------------------------

## 10. Advanced Features

### 10.1 Family & Genetic Risk Context

Allow users to record family health history.

Important distinction:

**Family history ≠ genetic testing.**

Do not claim actual genetic risk analysis unless real genetic data is
available.

A safer MVP feature is:

> "Family History Risk Context"

rather than claiming genomic analysis.

------------------------------------------------------------------------

### 10.2 Doctor Visit Preparation

Generate a concise summary for a medical consultation:

-   Recent reports
-   Important changes
-   Historical trends
-   Current medications entered by the user
-   Questions the user may want to discuss
-   Relevant observations

The output should assist communication with a doctor, not replace the
doctor's assessment.

------------------------------------------------------------------------

### 10.3 Personalized Diet & Lifestyle Guidance

Recommendations should be based on the available user context.

The system should:

-   Explain why a recommendation was generated.
-   Avoid extreme diets.
-   Avoid medical treatment claims.
-   Avoid replacing professional dietary/medical advice.

------------------------------------------------------------------------

### 10.4 Medication & Lab Awareness

If medication information is provided, the system can highlight
potential topics for discussion between medications and laboratory
results.

Do not make definitive medication-change recommendations.

The safe interaction is:

> "This combination may warrant discussion with a healthcare
> professional."

not:

> "Stop taking this medicine."

------------------------------------------------------------------------

### 10.5 Family Health Dashboard

A family account can organize health information for multiple members.

Each member should have:

-   Separate profile
-   Separate health records
-   Separate permissions
-   Separate AI context

Privacy must be preserved between family members.

------------------------------------------------------------------------

### 10.6 Reminders

Potential reminders:

-   Medication reminders
-   Health-check reminders
-   Follow-up reminders
-   Report upload reminders

------------------------------------------------------------------------

## 11. AI Architecture

The product should use different AI components for different jobs rather
than calling everything "AI."

### Layer 1 -- Document Intelligence

OCR/document parsing:

``` text
Report Image/PDF
      ↓
OCR
      ↓
Text + Tables
      ↓
Medical-value extraction
      ↓
Structured lab data
```

### Layer 2 -- Data Normalization

Normalize:

-   Test names
-   Numeric values
-   Units
-   Dates
-   Reference ranges

Human review should be possible before important data enters the health
profile.

### Layer 3 -- Longitudinal Trend Engine

``` text
Historical lab records
        ↓
Time-series comparison
        ↓
Trend detection
        ↓
Statistical/change analysis
        ↓
Structured insight
```

### Layer 4 -- ML Risk Models

Condition-specific models produce structured risk estimates.

``` text
Health features
      ↓
ML model
      ↓
Risk estimate + model metadata
```

### Layer 5 -- Explainability

The model output is converted into interpretable factors using
appropriate explainability techniques.

Possible implementation:

-   Feature importance
-   SHAP where appropriate
-   Threshold/range explanations
-   Trend-based explanations

### Layer 6 -- LLM Reasoning / Communication

The LLM receives **structured, validated information**, not raw
uncontrolled medical text whenever possible.

It is responsible for:

-   Explaining reports in simple language
-   Summarizing trends
-   Generating doctor-visit summaries
-   Conversational interaction
-   Turning structured model outputs into understandable explanations

The LLM should not independently invent diagnosis or numerical medical
predictions.

------------------------------------------------------------------------

## 12. Suggested AI Flow

``` text
User
 │
 ├── Upload Report ──→ OCR
 │                       ↓
 │                 Value Extraction
 │                       ↓
 │                 User Verification
 │                       ↓
 │                 Health Database
 │                       ↓
 │              Digital Health Twin
 │                       │
 │          ┌────────────┼────────────┐
 │          ↓            ↓            ↓
 │      Trends       ML Risk      LLM Layer
 │          ↓            ↓            ↓
 │          └────────────┼────────────┘
 │                       ↓
 │              Explainable Insight
 │                       ↓
 │             Personalized Guidance
 │                       ↓
 │                User Feedback
 │                       ↓
 │              Updated Health Twin
```

------------------------------------------------------------------------

## 13. Phone-First / iQOO Hackathon Strategy

The iQOO Hackathon emphasizes product quality, novelty/impact, technical
depth, creative phone usage, and Office Kit usage.

MedTwin AI should therefore make the phone central to the experience.

### Phone Capabilities

#### Camera

Use the phone camera to scan physical health reports.

``` text
Camera
 ↓
Document detection
 ↓
OCR
 ↓
AI extraction
 ↓
Health Twin update
```

#### Voice

Allow natural-language health journaling.

Example:

> "I have been sleeping badly for the last few days and haven't
> exercised."

The system converts the input into structured observations after user
confirmation.

#### On-Device / Local AI

Where feasible, use a local/open-source model for selected tasks such
as:

-   Lightweight text classification
-   Privacy-sensitive preprocessing
-   Local summarization
-   Structured extraction
-   Offline/low-connectivity assistance

Do not force local AI into tasks where it harms accuracy. The
architecture should clearly explain which model runs where and why.

#### Notifications

Use the phone for:

-   Reminders
-   Follow-up prompts
-   Report comparison alerts

------------------------------------------------------------------------

## 14. Privacy & Security

Health data is sensitive.

The prototype should prioritize:

-   Authentication
-   Authorization
-   Encryption in transit
-   Secure storage
-   Least-privilege access
-   Family-member data isolation
-   User-controlled export/delete functionality
-   Minimal data collection
-   Clear consent before processing

Do not claim "fully encrypted," "HIPAA compliant," "GDPR compliant," or
equivalent certifications unless the implementation has actually been
designed and verified to meet those requirements.

------------------------------------------------------------------------

## 15. Medical Safety Principles

MedTwin AI is a **preventive health-information companion**, not a
doctor.

### Never:

-   Diagnose a disease.
-   Claim certainty from a single laboratory value.
-   Tell users to stop/change prescription medication.
-   Replace emergency care.
-   Present an LLM response as medical fact without appropriate
    grounding.
-   Fabricate medical references.
-   Pretend that a risk score is clinically validated when it is only a
    prototype.
-   Treat OCR-extracted values as unquestionably correct.

### Always:

-   Show uncertainty where appropriate.
-   Preserve the source/reference range from reports.
-   Allow users to correct extracted data.
-   Encourage professional consultation for concerning findings.
-   Clearly distinguish data, model output, and LLM explanation.
-   Include emergency guidance where relevant.

------------------------------------------------------------------------

## 16. Product USP

### Primary USP

**Report-to-Report Health Intelligence**

Traditional health apps often store information. MedTwin AI attempts to
understand how available health markers change over time.

### Secondary USPs

1.  Digital Health Twin
2.  Multimodal report understanding
3.  Explainable risk awareness
4.  AI-generated doctor-visit preparation
5.  Scenario-based health simulation
6.  Phone-first health interaction
7.  Privacy-conscious architecture

------------------------------------------------------------------------

## 17. Demo Story

The strongest demo should focus on one believable user journey rather
than showing every feature.

### Demo Scenario

A user has three historical health reports.

#### Step 1 -- Scan

User points the phone camera at a report.

OCR extracts the values.

#### Step 2 -- Verify

The app displays extracted values and lets the user confirm them.

#### Step 3 -- Build Twin

The report is added to the user's Digital Health Twin.

#### Step 4 -- Compare

The user opens the timeline.

The app shows how selected markers changed across reports.

#### Step 5 -- Explain

AI explains the major changes in simple language.

#### Step 6 -- Risk Awareness

A selected ML model produces a risk estimate.

The app shows contributing factors and uncertainty.

#### Step 7 -- Ask the Twin

User asks:

> "What changed in my health over the last year?"

The LLM answers using the user's structured longitudinal data.

#### Step 8 -- Doctor Summary

The app generates a concise summary and discussion points for the next
medical appointment.

This creates a complete story:

**Raw report → structured data → longitudinal intelligence → ML →
explainability → LLM → real-world action.**

------------------------------------------------------------------------

## 18. MVP Scope

Do not attempt to build every advanced feature for the first version.

### Must Have

-   Authentication
-   Health profile
-   Report upload/camera capture
-   OCR
-   Medical-value extraction
-   User verification
-   Historical report storage
-   Trend visualization
-   LLM report explanation
-   Basic explainable risk model for one carefully selected use case
-   Doctor summary

### Nice to Have

-   Voice journaling
-   Family dashboard
-   Reminders
-   On-device model
-   Health simulation

### Avoid Building Too Early

-   Full genetic analysis
-   Large multi-condition prediction system
-   Complex medication interaction engine
-   Huge family-management system
-   Dozens of dashboards
-   Unverified medical claims

------------------------------------------------------------------------

## 19. Recommended Technical Stack

The exact stack can change according to the team's strengths.

### Frontend

-   React / Next.js
-   Responsive mobile-first UI
-   PWA capability if useful

### Backend

-   Node.js
-   Express or Next.js API routes

### Database

-   MongoDB or another secure document database

### AI

-   OCR/document parser
-   LLM API for grounded explanation and summarization
-   Open-source/local model for selected privacy-sensitive tasks
-   Python ML service if a dedicated prediction model is required

### Visualization

-   Charting library for longitudinal health trends

### Authentication

-   Secure session/token-based authentication
-   Role/permission controls for family accounts

------------------------------------------------------------------------

## 20. Data Strategy

Use realistic but clearly labeled demo data during the hackathon.

For ML:

-   Use appropriate public healthcare datasets.
-   Document the dataset source.
-   Document target variables and features.
-   Separate training/testing data properly.
-   Report basic model evaluation metrics.
-   Avoid claiming clinical validity from hackathon-level evaluation.

For demo reports:

-   Use synthetic/demo reports or appropriately licensed examples.
-   Do not expose real people's medical information.

------------------------------------------------------------------------

## 21. Technical Differentiator

The technical story should be:

> **MedTwin AI is not one LLM. It is an AI pipeline.**

``` text
OCR
 ↓
Structured medical data
 ↓
Longitudinal analytics
 ↓
ML risk model
 ↓
Explainability
 ↓
Grounded LLM
 ↓
Personalized interaction
```

This demonstrates genuine technical depth.

------------------------------------------------------------------------

## 22. Core Design Principle

Every AI feature must answer:

> **Why is AI necessary here?**

Good uses:

-   Understanding unstructured reports
-   Conversationally querying longitudinal data
-   Detecting patterns
-   Explaining complex outputs
-   Adapting communication to the user's context

Weak uses:

-   Generating generic health quotes
-   Chatbot-only symptom answers
-   Random AI-generated diet plans
-   AI-generated dashboards with no intelligence behind them

------------------------------------------------------------------------

## 23. Positioning Statement for Judges

> **"MedTwin AI turns fragmented health reports into a living,
> understandable health timeline. Instead of giving generic AI health
> answers, it combines OCR, longitudinal analysis, machine learning,
> explainability, and grounded LLM reasoning to help people understand
> how their health information is changing over time and prepare for
> better conversations with their doctors."**

------------------------------------------------------------------------

## 24. Important Project Rule

**Never sacrifice medical safety for a flashy demo.**

The strongest version of MedTwin AI is not the one that makes the
biggest medical claims.

It is the one that demonstrates:

**real data → real processing → explainable AI → useful insight →
responsible communication.**

That is the foundation for all future implementation, UI, architecture,
prompts, documentation, pitch scripts, and demo decisions.
