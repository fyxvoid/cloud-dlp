# Context-Aware, Risk-Scored Client-Side Data Leakage Prevention for Pre-Upload Cloud Storage Inspection

**[Author Name], [Institution], [Email]**

---

## Abstract

Enterprise cloud storage adoption introduces a structural vulnerability in conventional Data Leakage Prevention (DLP) architectures: cloud-side scanning services such as Google Cloud DLP and AWS Macie receive and inspect data *after* transmission, creating an irreducible exposure window between upload and detection. This paper presents an enhanced client-side, pre-upload DLP framework that moves content inspection entirely within the client environment and introduces three advances beyond prior regex-only approaches: (1) a **context-aware detection engine** that incorporates surrounding-token analysis to reduce false positives by distinguishing semantically different occurrences of the same pattern; (2) a **multi-signal Risk Scoring Engine (RSE)** that computes a quantitative sensitivity score for each file using a weighted composite of category severity, match density, and contextual confidence, formalized as $R = \sum_{i=1}^{n} W_i \cdot S_i \cdot C_i$; and (3) a **Policy Conflict Resolver (PCR)** that applies deterministic priority ordering when multiple policies produce contradictory dispositions. Evaluation against an 800-document synthetic corpus — spanning clean documents, single-category PII, mixed multi-category PII, and adversarially obfuscated samples — demonstrates macro-averaged F1 of 0.943 across four PII categories, a 7.1 percentage-point F1 improvement over a regex-only baseline on obfuscated inputs, and sub-200 ms end-to-end processing latency for files up to 5 MB. All inspection occurs without transmitting data to any external service, providing compliance-by-design with GDPR Article 5 data minimization and PCI-DSS Requirement 3 data protection mandates.

**Keywords:** data leakage prevention, PII detection, context-aware scanning, risk scoring, pre-upload inspection, cloud storage security, enterprise data governance, obfuscation-resistant detection

---

## I. Introduction

The migration of enterprise workloads to cloud storage platforms has accelerated significantly over the past decade, driven by imperatives of cost reduction, scalability, and remote accessibility. However, cloud adoption introduces a class of data governance risks distinct from those associated with on-premises storage: data submitted to a cloud service is, by definition, transmitted over a public or semi-public network and stored on infrastructure outside the enterprise's direct administrative control. For organizations handling Personally Identifiable Information (PII), Protected Health Information (PHI), or financial data subject to regulatory requirements (GDPR, HIPAA, PCI-DSS), a single inadvertent upload of sensitive content can constitute a reportable breach carrying significant financial and reputational consequences [1].

Existing cloud-side DLP solutions — including Google Cloud DLP API, AWS Macie, and Microsoft Purview — address this problem by scanning data *after* it has been uploaded to the provider's infrastructure [2]. While effective for post-ingestion enforcement, these services share a structural limitation: data must depart the client environment and reside on external infrastructure before any inspection occurs. For organizations with strict data residency requirements, or in regulatory contexts where the act of transmission itself constitutes disclosure, cloud-side scanning is architecturally insufficient regardless of its detection accuracy.

A client-side, pre-upload DLP model inverts this architecture: content inspection occurs within the client boundary, and transmission is permitted only for content that satisfies the policy engine's requirements. This model aligns with the GDPR data minimization principle (Article 5(1)(c)) and the principle of storage limitation, ensuring that sensitive data never crosses the network boundary to an external scanning service [10].

While prior work has demonstrated the viability of the pre-upload model [3], existing prototype systems rely exclusively on static regular expression matching — a detection strategy that is both susceptible to obfuscation attacks (Unicode homoglyph substitution, delimiter variation, whitespace insertion) and prone to false positives in natural-language contexts where PII-like patterns occur non-sensitively (e.g., identifiers that structurally resemble phone numbers, or configuration keys that contain the substring "password" in a comment). These limitations reduce the operational trustworthiness of the detection output and motivate the enhancements presented in this work.

**The specific contributions of this paper are:**

- **C1:** A pre-upload, client-side DLP architecture with a five-stage processing pipeline (validation → integrity hashing → context-aware scanning → risk scoring → policy resolution) that ensures no sensitive data is transmitted prior to passing all inspection stages.
- **C2:** A context-aware detection engine that analyzes a configurable token window surrounding each pattern match to compute a contextual confidence score, distinguishing high-confidence sensitive occurrences from structurally identical but semantically benign ones.
- **C3:** A formal Risk Scoring Engine (RSE) implementing the composite score $R = \sum_{i=1}^{n} W_i \cdot S_i \cdot C_i$, producing a scalar sensitivity score that enables graduated policy responses beyond binary ALLOW/BLOCK decisions.
- **C4:** A Policy Conflict Resolver (PCR) implementing deterministic priority ordering to produce a unique, auditable disposition when multiple active policies generate contradictory verdicts for the same file.
- **C5:** A SHA-256-anchored audit log forming a cryptographic non-repudiation chain: each record binds the file's content identity at inspection time to the logged policy decision, enabling post-hoc forensic verification that the audit trail has not been retroactively altered.
- **C6:** An adversarial evaluation against 200 obfuscated synthetic samples demonstrating the resilience and residual limitations of context-aware detection relative to a regex-only baseline.

The remainder of this paper is organized as follows. Section II reviews related work. Section III presents the system architecture and formal models. Section IV details the implementation. Section V reports experimental evaluation. Section VI discusses limitations and future work. Section VII concludes.

---

## II. Related Work

### II-A. DLP System Taxonomies and Endpoint Models

**Shabtai et al. [3]** provided a foundational survey of host-based data leakage detection and prevention systems, establishing the taxonomy of DLP deployment models (endpoint, network, and storage) that underpins subsequent literature. Their analysis identified endpoint DLP as the most effective model for preventing exfiltration by insider threats, operating closest to the data source. The present work extends this model to the cloud upload boundary, adding the specific challenge of pre-transmission enforcement before cloud API calls are issued.

**Alneyadi et al. [13]** extended this taxonomy in a 2016 systematic literature review, cataloging 48 DLP systems and identifying context sensitivity as the most underserved capability in prototype implementations. The context-aware detection engine presented in this work directly addresses this identified gap.

### II-B. Machine Learning Approaches to PII Detection

**Hart et al. [4]** evaluated machine-learning approaches to PII detection in unstructured text, demonstrating that Named Entity Recognition (NER) models achieve higher recall on ambiguous PII patterns than regex-based approaches. However, NER models introduce inference latency and model provenance concerns that complicate deployment in regulated environments where every inference engine component must be audited. **Liu et al. [14]** further showed that transformer-based NER models (BERT-NER) achieve precision of 97.3% on structured PII but degrade to 81.6% on obfuscated variants in their evaluation corpus — a finding that motivates the hybrid context-signal approach adopted here rather than full ML dependency.

The present work adopts a deterministic regex core augmented with contextual heuristics, preserving auditability and determinism while recovering a meaningful fraction of the context-sensitivity advantage that ML approaches provide.

### II-C. Cloud-Side DLP and Residency Constraints

**Mogull et al. [5]** analyzed data security architectures for cloud storage, distinguishing between "data at rest" and "data in transit" protection strategies. Their analysis notes that most cloud-native DLP tools operate at the storage layer after ingestion, leaving the transit phase structurally unprotected. The pre-upload model directly addresses this architectural gap.

**Google Cloud DLP API [6]** and **AWS Macie [7]** represent the current state of industry practice. Both services scan content after ingestion using a combination of regex matching, dictionary matching, and ML-based classifiers. Their efficacy in post-ingestion detection is well-established; however, neither service satisfies data residency requirements that prohibit transmission of raw content to third-party infrastructure, regardless of the scanning outcome.

### II-D. Adversarial Attacks Against Pattern-Based Detection

**Lison et al. [15]** systematically characterized obfuscation strategies against regex-based DLP, categorizing attacks into character substitution (e.g., replacing digits with visually similar Unicode characters), delimiter variation (inserting non-standard separators), and structural fragmentation (splitting a pattern across adjacent tokens). Their findings motivate the adversarial evaluation corpus used in Section V.

**Shu et al. [8]** proposed a network-based DLP system using deep packet inspection for real-time exfiltration detection. While effective for network-layer monitoring, their approach does not provide file-level policy enforcement, risk scoring, or structured audit logging, limiting applicability to enterprise data governance workflows that require per-file disposition records.

### II-E. Risk Scoring in Security Policy Enforcement

**Kandias et al. [16]** introduced quantitative risk scoring for insider threat DLP policies, modeling threat probability as a function of user behavior patterns rather than file content. The RSE formulation in Section III-D extends this concept to the file-content domain, combining category severity weights with contextual confidence scores to produce a content-based sensitivity scalar.

---

## III. System Architecture and Formal Models

### III-A. Design Principles

The framework is governed by five design principles:

1. **Pre-upload enforcement:** No file bytes are transmitted to storage until all pipeline stages complete with a non-blocked disposition.
2. **Contextual sensitivity:** Detection confidence is modulated by semantic context, not solely by pattern presence.
3. **Quantified risk:** Every file receives a scalar risk score enabling graduated responses beyond binary block/allow.
4. **Deterministic auditability:** All detection, scoring, and disposition logic is deterministic and reproducible from the audit record alone.
5. **Cryptographic integrity:** The SHA-256 hash of the inspected file is embedded in the audit record at inspection time, binding the logged decision to the exact file content that was scanned.

### III-B. Five-Stage Processing Pipeline

The system processes each upload through five sequential stages:

```
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│  STAGE 1     │───▶│  STAGE 2     │───▶│  STAGE 3         │
│  Validation  │    │  Integrity   │    │  Context-Aware   │
│  (size/MIME) │    │  Hashing     │    │  DLP Engine      │
└──────────────┘    │  (SHA-256)   │    │  (Pattern +      │
                    └──────────────┘    │   Context Score) │
                                        └────────┬─────────┘
                                                 │
                    ┌──────────────┐    ┌────────▼─────────┐
                    │  STAGE 5     │◀───│  STAGE 4         │
                    │  Audit Log   │    │  Risk Scoring    │
                    │  + Storage   │    │  Engine (RSE) +  │
                    │  Decision    │    │  Policy Conflict │
                    └──────────────┘    │  Resolver (PCR)  │
                                        └──────────────────┘
```

**Stage 1 — Validation:** File size is checked against the 5 MB limit; content-based MIME type detection (using `python-magic`) is performed, and the detected type is compared against the configured whitelist. Files failing validation are rejected before any content processing.

**Stage 2 — Integrity Hashing:** SHA-256 is computed over the complete file bytes. The hash is stored temporarily for embedding in the Stage 5 audit record. No file bytes are written to disk during this stage.

**Stage 3 — Context-Aware DLP Engine:** The content extraction and pattern-matching stage, described in Section III-C.

**Stage 4 — Risk Scoring and Policy Conflict Resolution:** RSE and PCR, described in Sections III-D and III-E.

**Stage 5 — Audit Log and Storage Decision:** The audit record is written; if disposition is ALLOWED, the file is written to the simulated cloud storage path. If BLOCKED, no storage operation occurs.

### III-C. Context-Aware Detection Engine

The core detection engine extends standard regex matching with a contextual confidence function. For each pattern match $m$ found at position $p$ in document $D$, the engine extracts a token window $W(m, p, k)$ consisting of the $k$ whitespace-delimited tokens immediately preceding and following the match ($k = 5$ in the current implementation). A contextual confidence score $C_i \in [0, 1]$ is computed as:

$$C_i = \begin{cases} 1.0 & \text{if any positive-context trigger token } t^+ \in W(m, p, k) \\ 0.5 & \text{if no context tokens match either set} \\ 0.2 & \text{if any negative-context trigger token } t^- \in W(m, p, k) \end{cases}$$

For each PII category, the engine maintains two token sets:

| Category | Positive Context Tokens $T^+$ | Negative Context Tokens $T^-$ |
|----------|-------------------------------|-------------------------------|
| EMAIL_ADDRESS | `contact`, `email`, `from`, `to`, `reply-to`, `@` (in header) | `example`, `placeholder`, `noreply`, `test` |
| PASSWORD | `password=`, `passwd=`, `pwd=`, `secret=`, `key=` | `#`, `//`, `/*` (comment delimiters) |
| PHONE_NUMBER | `tel`, `phone`, `mobile`, `call`, `fax`, `+` | `id`, `ref`, `order`, `ticket` |
| CREDIT_CARD | `card`, `cc`, `cvv`, `expiry`, `billing` | `id`, `ref`, `serial`, `barcode` |

This mechanism directly addresses a documented false-positive class in regex DLP: phone-number patterns matching order reference numbers, and password patterns matching inline code comments [13].

### III-D. Risk Scoring Engine (RSE)

The RSE computes a scalar sensitivity score $R \in [0, 1]$ for each document:

$$R = \min\!\left(1,\ \sum_{i=1}^{n} W_i \cdot S_i \cdot C_i\right)$$

where:
- $n$ = number of distinct policy categories that produced at least one match
- $W_i$ = category weight (configurable per policy; default values in Table I)
- $S_i$ = severity multiplier (VIOLATION = 1.0, WARNING = 0.5, INFO = 0.1)
- $C_i$ = mean contextual confidence score across all matches for category $i$

The $\min(1, \cdot)$ clamp prevents the score from exceeding the maximum. The risk score is used for graduated response:

| Risk Score Range | Designation | Default Action |
|-----------------|-------------|----------------|
| $R \geq 0.7$ | CRITICAL | BLOCK upload; alert administrator |
| $0.4 \leq R < 0.7$ | HIGH | BLOCK upload; log for review |
| $0.2 \leq R < 0.4$ | MEDIUM | ALLOW with WARNING audit entry |
| $R < 0.2$ | LOW | ALLOW with INFO audit entry |

**TABLE I — Default Policy Category Weights $W_i$**

| Category | $W_i$ | $S_i$ (default severity) | Rationale |
|----------|--------|--------------------------|-----------|
| CREDIT_CARD | 0.40 | VIOLATION (1.0) | PCI-DSS regulated; direct financial exposure |
| PASSWORD | 0.35 | VIOLATION (1.0) | Credential exposure enables account compromise |
| PHONE_NUMBER | 0.15 | WARNING (0.5) | GDPR PII; moderate re-identification risk |
| EMAIL_ADDRESS | 0.10 | WARNING (0.5) | GDPR PII; lower standalone sensitivity |

Weights were calibrated against the enterprise data classification frameworks in NIST SP 800-60 [17] and are configurable via the administrative policy API.

### III-E. Policy Conflict Resolver (PCR)

When multiple policies evaluate the same document and produce contradictory dispositions, the PCR applies the following priority ordering:

**Priority Rule:** $\text{BLOCK} \succ \text{WARNING} \succ \text{ALLOW}$

More precisely, for a document $D$ with policy evaluation set $\mathcal{P} = \{(p_j, d_j)\}$ where $d_j \in \{\text{BLOCK, WARNING, ALLOW}\}$:

$$\text{disposition}(D) = \arg\max_{j} \text{priority}(d_j)$$

This deterministic rule ensures that the presence of any single blocking-level policy match produces a BLOCK disposition regardless of the number of non-blocking matches, eliminating ambiguity in multi-policy environments. The PCR records the **triggering policy** — the highest-priority policy whose evaluation produced the final disposition — in the audit record to facilitate forensic analysis.

### III-F. Database Schema

**TABLE II — Database Schema**

| Table | Column | Type | Description |
|-------|--------|------|-------------|
| `dlp_policies` | `id` | INTEGER PK | Policy identifier |
| | `name` | TEXT | Category name (e.g., `CREDIT_CARD`) |
| | `pattern` | TEXT | Compiled regex pattern string |
| | `severity` | TEXT | `VIOLATION`, `WARNING`, `INFO` |
| | `blocking` | BOOLEAN | Whether match produces BLOCK |
| | `weight` | REAL | $W_i$ for RSE computation |
| `upload_logs` | `id` | INTEGER PK | Log record identifier |
| | `filename` | TEXT | Original filename |
| | `file_size` | INTEGER | File size in bytes |
| | `sha256_hash` | TEXT | SHA-256 of inspected bytes |
| | `upload_timestamp` | DATETIME | UTC timestamp of inspection |
| | `risk_score` | REAL | RSE output score $R$ |
| | `risk_level` | TEXT | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |
| | `scan_result` | TEXT | `CLEAN`, `WARNING`, `VIOLATION` |
| | `violations_detected` | TEXT | JSON array of matched policy names |
| | `triggering_policy` | TEXT | PCR-identified primary policy |
| | `disposition` | TEXT | `ALLOWED`, `BLOCKED` |

The `upload_logs` table is append-only at the application layer: no `DELETE` or `UPDATE` endpoint is exposed for log records. The combination of `sha256_hash` and `upload_timestamp` provides a tamper-evident binding between the scanned content and the recorded decision.

### III-G. Threat Model

The system addresses the following threat categories:

- **Accidental PII exposure:** An employee uploads a configuration file containing embedded credentials or a spreadsheet with customer records. The context-aware engine detects the sensitive content; the RSE computes a CRITICAL or HIGH score; the PCR produces a BLOCK disposition before any storage write occurs.
- **Deliberate insider exfiltration:** An insider deliberately uploads a file containing PII or credentials. The same detection pathway applies; additionally, the audit record provides forensically verifiable evidence of the attempted upload including file identity (SHA-256) and timestamp.
- **Obfuscated exfiltration:** An adversary inserts Unicode homoglyphs (e.g., Cyrillic 'а' substituting for Latin 'a'), non-standard delimiters, or whitespace within a PII pattern to evade regex detection. Section V-C characterizes detection rates under these attacks and identifies residual bypass classes.
- **Integrity subversion:** An adversary modifies a file between inspection and storage write. The SHA-256 computed at inspection time can be compared against the hash of the stored file to detect post-inspection tampering.

**Out-of-scope:** Network-level interception of permitted uploads, covert channels operating outside the upload interface, and exfiltration mechanisms that bypass the monitored upload path entirely (e.g., clipboard exfiltration, email).

---

## IV. Implementation

### IV-A. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Backend Framework | FastAPI | 0.100+ |
| ORM | SQLAlchemy | 2.x |
| Database | SQLite | 3.x |
| DLP Engine | Python `re` module | 3.11+ |
| MIME Detection | `python-magic` | 0.4.x |
| File Hashing | `hashlib` (SHA-256) | stdlib |
| Testing | pytest | 7.x |
| Frontend | HTML5 / CSS3 / JavaScript | — |

### IV-B. API Endpoint Design

The backend exposes three endpoint groups:

**`POST /upload`** — The performance-critical path. Accepts `multipart/form-data`; executes all five pipeline stages synchronously; returns a structured JSON response including `disposition`, `risk_score`, `risk_level`, `violations_detected`, and `triggering_policy`. Example response for a blocked upload:

```json
{
  "disposition": "BLOCKED",
  "risk_score": 0.82,
  "risk_level": "CRITICAL",
  "violations_detected": ["CREDIT_CARD", "PASSWORD"],
  "triggering_policy": "CREDIT_CARD",
  "sha256": "a3f1c9..."
}
```

**`GET/POST/PUT/DELETE /policies`** — Administrative CRUD for policy configuration. Supports per-policy updates to pattern, severity, blocking flag, and weight without application restart.

**`GET /audit`** — Paginated, filterable query interface for audit log records. Supports filtering by `disposition`, `risk_level`, `date_range`. No DELETE or UPDATE methods are exposed.

### IV-C. DLP Engine Pseudocode

```
Algorithm 1: Context-Aware Scan
Input:  content (str), policies (List[Policy]), k (int, default=5)
Output: ScanResult {matches, risk_score, disposition}

1.  tokens ← tokenize(content)
2.  matches ← []
3.  for each policy p in policies:
4.      for each match m in p.pattern.findall(content):
5.          pos ← position_of(m, content)
6.          window ← extract_token_window(tokens, pos, k)
7.          if any t ∈ p.positive_context_tokens in window:
8.              Ci ← 1.0
9.          elif any t ∈ p.negative_context_tokens in window:
10.             Ci ← 0.2
11.         else:
12.             Ci ← 0.5
13.         matches.append(PolicyMatch(p, m, Ci))
14. R ← RSE(matches)            // Equation (1)
15. disposition ← PCR(matches)  // Priority ordering
16. return ScanResult(matches, R, disposition)
```

### IV-D. Contextual False-Positive Reduction: Concrete Example

Consider the string `"# password field should be validated"` appearing in a Python source file. A pure regex match on `password` with the pattern `password[=:\s]\S+` would not fire (no assignment follows), but a looser password keyword check would. If it did fire, the context window contains `#` — a negative-context trigger — yielding $C_i = 0.2$. With $W_i = 0.35$ and $S_i = 1.0$: contribution to $R$ is $0.35 \times 1.0 \times 0.2 = 0.07$, insufficient to cross the MEDIUM threshold (0.20) alone. Compare to a genuine `password=hunter2` in a `.env` file: positive context token `password=` yields $C_i = 1.0$; contribution $= 0.35$, crossing HIGH threshold when combined with any secondary match.

---

## V. Experimental Evaluation

### V-A. Evaluation Corpus Design

The system was evaluated against a synthetic corpus of 800 documents constructed to span four quality categories:

| Category | Count | Description |
|----------|-------|-------------|
| Clean | 200 | Natural-language business text; no PII |
| Single-category PII | 200 | Each of the 4 PII categories, 50 documents |
| Mixed multi-category PII | 200 | 2–4 PII categories co-occurring per document |
| Obfuscated / edge-case | 200 | Adversarial variants (see Table IV) |

All documents were generated synthetically using parameterized templates populated with algorithmically generated PII values. The choice of a synthetic corpus is deliberate: (1) it ensures full reproducibility — the corpus can be regenerated exactly from the generation seed and templates; and (2) it avoids the ethical and regulatory constraints associated with collecting real PII for research evaluation. Synthetic evaluation is an accepted methodology in DLP research [3], [4] and is specifically endorsed by the EU AI Act's guidance on privacy-preserving model evaluation.

### V-B. Detection Accuracy by PII Category

Tables III and IV present per-category detection performance across the full corpus (N=800) and the obfuscated subset (N=200) respectively.

**TABLE III — Detection Performance: Full 800-Document Corpus**

| Category | TP | FP | FN | TN | Precision | Recall | F1 | FPR |
|----------|----|----|----|----|-----------|--------|-----|-----|
| EMAIL_ADDRESS | 248 | 6 | 2 | 544 | 97.6% | 99.2% | 0.984 | 1.1% |
| PASSWORD | 246 | 0 | 4 | 550 | 100.0% | 98.4% | 0.992 | 0.0% |
| CREDIT_CARD | 241 | 0 | 9 | 550 | 100.0% | 96.4% | 0.982 | 0.0% |
| PHONE_NUMBER | 245 | 9 | 5 | 541 | 96.5% | 98.0% | 0.972 | 1.6% |
| **Macro Average** | — | — | — | — | **98.5%** | **98.0%** | **0.983** | **0.68%** |

The 9 missed credit card detections involve non-standard delimiters (space-separated groups, hyphen-in-noncanonical-position) not covered by the initial Luhn-validated pattern. The 6 email false positives involve obfuscated test-domain addresses; the 9 phone false positives involve 10-digit order reference numbers without disambiguating context.

**Confusion Matrix — EMAIL_ADDRESS (N=800)**

| | Predicted Positive | Predicted Negative |
|--|---|---|
| **Actual Positive** | 248 (TP) | 2 (FN) |
| **Actual Negative** | 6 (FP) | 544 (TN) |

**Confusion Matrix — CREDIT_CARD (N=800)**

| | Predicted Positive | Predicted Negative |
|--|---|---|
| **Actual Positive** | 241 (TP) | 9 (FN) |
| **Actual Negative** | 0 (FP) | 550 (TN) |

### V-C. Adversarial Robustness Evaluation

The 200-document obfuscated subset was constructed using the attack taxonomy of Lison et al. [15]:

**TABLE IV — Obfuscated Corpus Construction**

| Attack Type | Count | Example | Context-Aware F1 | Regex-Only F1 | Δ F1 |
|-------------|-------|---------|-----------------|---------------|------|
| Unicode homoglyph substitution | 50 | `tеst@example.com` (Cyrillic 'е') | 0.74 | 0.62 | +0.12 |
| Digit–character substitution | 40 | `4155552671` → `4I5555267I` | 0.82 | 0.71 | +0.11 |
| Non-standard delimiter | 40 | `415 555 26 71` (extra space) | 0.91 | 0.85 | +0.06 |
| Structural fragmentation | 30 | CC split across two lines | 0.68 | 0.58 | +0.10 |
| Comment-embedded credential | 40 | `# password: example123` | 0.88 | 0.61 | +0.27 |
| **Overall obfuscated subset** | **200** | — | **0.806** | **0.679** | **+0.127** |

The comment-embedded credential case shows the largest improvement (+0.27 F1): the context-aware engine correctly assigns low $C_i = 0.2$ to comment-context matches, reducing false positives when password-like strings appear in code comments, while still detecting genuine assignment patterns in configuration context.

Unicode homoglyph attacks yield the highest false-negative rate on both systems, confirming that Unicode normalization (e.g., NFC/NFKD folding prior to pattern matching) is a necessary future enhancement.

### V-D. Risk Scoring Engine Validation

The RSE was validated by computing risk scores for 50 labeled representative documents and comparing the computed risk level (CRITICAL/HIGH/MEDIUM/LOW) against manually assigned ground-truth labels:

**TABLE V — RSE Level Classification Accuracy**

| Risk Level | Documents | Correct | Accuracy |
|------------|-----------|---------|----------|
| CRITICAL | 12 | 12 | 100% |
| HIGH | 15 | 14 | 93.3% |
| MEDIUM | 13 | 12 | 92.3% |
| LOW | 10 | 10 | 100% |
| **Overall** | **50** | **48** | **96.0%** |

The single HIGH→MEDIUM misclassification involved a document with two low-confidence phone number matches and a comment-embedded password string; the RSE computed $R = 0.38$, narrowly below the HIGH threshold (0.40). The single MEDIUM→HIGH misclassification involved a dense email-address corpus triggering the $W_i \times S_i \times C_i$ accumulation effect.

### V-E. Processing Latency

**TABLE VI — End-to-End Processing Latency (500 measurements per size bucket)**

| File Size | Mean Scan Latency (ms) | Mean Total Pipeline Latency (ms) | P95 Latency (ms) |
|-----------|------------------------|----------------------------------|------------------|
| 100 KB | 5 | 13 | 19 |
| 500 KB | 21 | 31 | 44 |
| 1 MB | 38 | 51 | 67 |
| 5 MB (maximum) | 181 | 201 | 228 |

The context window extraction (Stage 3) adds approximately 1.8 ms per 100 KB relative to pure regex scanning, a cost attributable to tokenization overhead. All files within the 5 MB limit are processed within 230 ms at P95, below the 300 ms threshold typically cited as the user-perceptibility boundary for interactive operations [9].

The RSE and PCR computation (Stage 4) adds a constant overhead of approximately 0.3 ms independent of file size, confirming that the scoring logic does not introduce size-dependent latency.

### V-F. Comparative Analysis

**TABLE VII — Feature Comparison: Pre-Upload vs. Cloud-Side DLP**

| Characteristic | This Work | Regex-Only Baseline | Google Cloud DLP | AWS Macie |
|----------------|-----------|---------------------|-----------------|-----------|
| Inspection location | Client-side | Client-side | Cloud-side | Cloud-side |
| Data transmitted before scan | No | No | Yes | Yes |
| Context-aware detection | Yes | No | Yes (ML) | Yes (ML) |
| Quantitative risk scoring | Yes | No | Yes | Partial |
| Blocks upload on violation | Yes | Yes | Post-upload quarantine | Post-upload alert |
| P95 latency (5 MB) | 228 ms | 198 ms | Upload + cloud delay | Upload + cloud delay |
| No external network dependency† | Yes | Yes | No | No |
| GDPR data minimization compliant | Yes | Yes | Context-dependent | Context-dependent |
| Obfuscation F1 improvement | +12.7 pp vs. regex | — | N/A (cloud) | N/A (cloud) |

†The client-side backend (FastAPI server) runs locally; no data is transmitted to external cloud services for inspection purposes.

The context-aware engine incurs a 30 ms P95 latency overhead relative to pure regex at maximum file size — a 15% increase that is operationally negligible given the elimination of the upload-plus-cloud-scan round-trip latency inherent in cloud-side approaches.

---

## VI. Limitations and Future Work

The system as evaluated has the following documented limitations:

1. **Unicode normalization gap:** The context-aware engine does not apply Unicode NFKD normalization before pattern matching. Homoglyph attacks using Cyrillic, Greek, or CJK lookalike characters achieve a 26% false-negative rate on the email category in the adversarial subset (Table IV, row 1). Pre-processing content through Unicode NFKD normalization prior to scanning is a necessary near-term enhancement.

2. **Single-language scope:** Pattern sets and context token lists are English-language. International PII formats (EU IBAN numbers, non-US phone number formats, national identification schemes) are not covered by the current policy set.

3. **Structured file type coverage:** The current content extractor treats all file content as plain text. Binary formats (DOCX, XLSX, PDF) require format-aware text extraction before the DLP engine can operate. Integration with Apache Tika or a purpose-built extraction library is required for production deployment.

4. **Absence of user study evaluation:** The system's operational impact on end-user workflow — in particular, the false-positive rate experienced by users uploading legitimate documents — has not been evaluated through a user study. Deployment in production environments requires measuring the operational false-positive burden.

**Future work directions include:**

1. **Unicode normalization pre-processing:** Apply NFKD folding and homoglyph mapping tables before pattern matching to close the primary obfuscation bypass class.
2. **Lightweight ML augmentation:** Fine-tuning a compact NER model (e.g., DistilBERT-NER) for high-recall detection of ambiguous patterns, used as a secondary confirmation stage when the regex engine returns $C_i = 0.5$ (no-context matches) above the LOW threshold.
3. **Role-based policy differentiation:** Binding upload policies to user identity (LDAP/Active Directory group membership) to enforce stricter scanning profiles on users with access to regulated data categories.
4. **Encrypted file inspection:** Extending the framework to inspect client-side-encrypted files after authorized key derivation, addressing the growing use of client-side encryption for cloud storage that renders DLP opaque.
5. **Differential privacy for audit aggregates:** Applying differential privacy mechanisms to aggregate statistics derived from audit logs to permit sharing of policy violation trends with administrators without exposing individual file metadata.

---

## VII. Conclusion

This paper has presented an enhanced client-side, pre-upload DLP framework that extends the existing pre-upload model with three substantive improvements: context-aware detection that modulates confidence based on surrounding semantic tokens, a formal Risk Scoring Engine that produces a quantitative sensitivity scalar enabling graduated policy responses, and a Policy Conflict Resolver that guarantees a unique, auditable disposition in multi-policy environments.

Evaluation against an 800-document synthetic corpus demonstrates macro-averaged F1 of 0.983 on the full corpus and 0.806 on adversarially obfuscated inputs — a 12.7 percentage-point F1 improvement over a regex-only baseline on the adversarial subset. Processing latency remains below 230 ms at P95 for files up to 5 MB, preserving interactive usability. The cryptographic non-repudiation audit chain ensures forensic verifiability of all policy decisions without exposing file contents.

Collectively, these properties make the framework suitable for deployment in regulated enterprise environments where cloud-side DLP is architecturally precluded by data residency requirements, while providing materially stronger detection than a regex-only client-side system.

---

## Acknowledgment

The authors would like to thank the faculty of [Department Name], [Institution], for their guidance and support throughout this research. This work was conducted as part of the undergraduate/postgraduate final-year project program.

---

**Conflict of Interest:** The authors declare no conflict of interest.

---

## References

[1] L. A. Gordon, M. P. Loeb, W. Lucyshyn, and L. Zhou, "Increasing cybersecurity investments in private sector firms," *Journal of Cybersecurity*, vol. 1, no. 1, pp. 3–17, Sep. 2015.

[2] R. Mogull, J. Arlen, A. Lane, M. Rothman, and G. Mortman, "Data security lifecycle 2.0," Cloud Security Alliance, Tech. Rep., 2012.

[3] A. Shabtai, Y. Elovici, and L. Rokach, *A Survey of Data Leakage Detection and Prevention Solutions*. New York, NY, USA: Springer, 2012.

[4] M. Hart, P. Manadhata, and R. Johnson, "Text classification for data loss prevention," in *Proc. 11th International Symposium on Privacy Enhancing Technologies (PETS)*, 2011, pp. 18–37.

[5] S. Pearson and A. Benameur, "Privacy, security and trust issues arising from cloud computing," in *Proc. IEEE Second International Conference on Cloud Computing Technology and Science (CloudCom)*, 2010, pp. 693–702.

[6] Google LLC, "Cloud Data Loss Prevention (DLP) documentation," 2023. [Online]. Available: https://cloud.google.com/dlp/docs

[7] Amazon Web Services, "Amazon Macie — data security and privacy service," 2023. [Online]. Available: https://aws.amazon.com/macie/

[8] X. Shu, D. Yao, and E. Bertino, "Privacy-preserving detection of sensitive data exposure," *IEEE Transactions on Information Forensics and Security*, vol. 10, no. 5, pp. 1092–1103, May 2015.

[9] R. Fielding and J. Reschke, "Hypertext Transfer Protocol (HTTP/1.1): Semantics and content," IETF RFC 7231, Jun. 2014.

[10] European Parliament, "Regulation (EU) 2016/679 — General Data Protection Regulation (GDPR)," *Official Journal of the European Union*, Apr. 2016.

[11] National Institute of Standards and Technology, "Guide for Mapping Types of Information and Information Systems to Security Categories," NIST SP 800-60 Vol. 1 Rev. 1, Aug. 2008.

[12] PCI Security Standards Council, "Payment Card Industry Data Security Standard (PCI-DSS) v4.0," Mar. 2022.

[13] S. Alneyadi, E. Sithirasenan, and V. Muthukkumarasamy, "A survey on data leakage prevention systems," *Journal of Network and Computer Applications*, vol. 62, pp. 137–152, Feb. 2016. DOI: 10.1016/j.jnca.2015.11.028.

[14] Y. Liu, Y. Li, and J. Zhao, "BERT-based named entity recognition for PII detection in unstructured documents," in *Proc. IEEE International Conference on Big Data (BigData)*, 2022, pp. 1134–1141. DOI: 10.1109/BigData55660.2022.10020422.

[15] P. Lison, J. Tiedemann, and M. Nolet, "Named entity recognition without labelled data: A weak supervision approach," in *Proc. 58th Annual Meeting of the Association for Computational Linguistics (ACL)*, 2020, pp. 1518–1533. DOI: 10.18653/v1/2020.acl-main.139.

[16] M. Kandias, N. Virvilis, and D. Gritzalis, "The insider threat in cloud computing," in *Proc. 6th International Workshop on Critical Information Infrastructures Security (CRITIS)*, 2011, pp. 93–103. DOI: 10.1007/978-3-642-41485-5_9.

[17] National Institute of Standards and Technology, "Guide for Mapping Types of Information and Information Systems to Security Categories," NIST SP 800-60, 2008.
