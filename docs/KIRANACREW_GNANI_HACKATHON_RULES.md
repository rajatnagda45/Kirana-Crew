# Gnani AI — Great Indian AI Internship Challenge 2026

## Rules, Compliance Guide, and Engagement Strategy

> **Source document status**: All claims are tagged [VERIFIED FROM OFFICIAL SOURCE], [INFERRED], or [UNVERIFIED ASSUMPTION].
> Primary sources: https://www.gnani.ai/internship and https://www.gnani.ai/resources/blogs/great-indian-ai-internship-challenge-2026
> Research conducted: November 2026

---

## 1. Competition Overview

The **Great Indian AI Internship Challenge 2026** is a student hackathon hosted by Gnani AI, a Bengaluru-based voice AI company. The competition invites Indian college students to build working applications using Gnani AI's models (Prisma STT, Timbre TTS, Evon LLM). The theme is "Build Sovereign AI for India." [VERIFIED FROM OFFICIAL SOURCE — gnani.ai/internship]

**Key facts:**

- Hosted by: Gnani AI (gnani.ai) [VERIFIED]
- Format: Open brief — no predetermined problem statement [VERIFIED]
- Prize pool: Up to 100 paid internships + 10 awards of ₹50,000 each = ₹5 lakh total award pool [VERIFIED]
- Timeline: October 1, 2026 (opens) → November 10, 2026, 11:59 PM IST (deadline) [VERIFIED]
- Internship start: January 1, 2027 [VERIFIED]
- Internship duration: Six months [VERIFIED]
- Internship stipend: Up to ₹1 lakh per month, per intern (individual, not team-split) [VERIFIED]
- Each registrant receives: 5,000 programme credits for Gnani API usage [VERIFIED]

---

## 2. Official Rules (Extracted from Official Sources)

All rules below are sourced from https://www.gnani.ai/internship and https://www.gnani.ai/resources/blogs/great-indian-ai-internship-challenge-2026. [VERIFIED FROM OFFICIAL SOURCE]

1. **One entry per person/team**: Each individual or team may submit only one project. [VERIFIED]
2. **Must use Gnani AI**: Every submission must use at least one Gnani AI model or API. [VERIFIED]
3. **Public posting required**: The demo video must be posted on LinkedIn, X (Twitter), or both with the required hashtags. Posts must be live before final submission. [VERIFIED]
4. **No purchased engagement**: Purchased engagement, bots, paid promotion, engagement exchanges are explicitly prohibited and result in disqualification. [VERIFIED]
5. **No plagiarism**: Submissions must be original work by the named participants. [VERIFIED]
6. **No misleading demos**: Fake demonstrations are prohibited. [VERIFIED]
7. **Synthetic data only for demos**: "Use synthetic data only" — no real phone numbers, Aadhaar numbers, PAN numbers, account numbers, or recorded calls in demos. [VERIFIED]
8. **Fixed deadline**: November 10, 2026, 11:59 PM IST. No extensions granted. [VERIFIED]
9. **Team interviews are independent**: In a two-person team, each member is interviewed separately; one can receive an offer without the other. [VERIFIED]
10. **Award maximum**: An individual or team can win a maximum of one award. [VERIFIED]
11. **Award and internship are independent**: Winning an award does not guarantee an internship offer, and vice versa. [VERIFIED]

---

## 3. Eligibility Requirements

All three conditions must be met on registration day. [VERIFIED FROM OFFICIAL SOURCE]

| Condition  | Requirement                                                              |
| ---------- | ------------------------------------------------------------------------ |
| Enrollment | Currently enrolled in a degree/course at an Indian college or university |
| Age        | At least 18 years old at the time of registration                        |
| Team size  | Solo or exactly two members (both must individually meet eligibility)    |

**Stream of education accepted** (from registration form): BTech, MTech, BBA, MBA, BCA, MCA, BSc, Other [VERIFIED — registration form]

---

## 4. Participation Rules (Individual vs. Team)

[VERIFIED FROM OFFICIAL SOURCE]

- **Solo**: One eligible participant builds and submits independently. Qualifies for Solo Ninja Award.
- **Team of two**: Both members must be individually eligible. Team qualifies for Two-Person Army Award.
- **No teams of three or more**: Maximum team size is two people. [VERIFIED]
- **Split interviews**: Each team member is interviewed one-on-one. An internship offer to one teammate does not obligate an offer to the other. [VERIFIED]
- **Stipends are individual**: Stipends are not split between teammates; each member, if selected, receives their own stipend. [VERIFIED]
- **One entry only**: A team or individual may submit only one project. [VERIFIED]

---

## 5. Required Gnani AI Integrations

[VERIFIED FROM OFFICIAL SOURCE]

Every submission must integrate at least one of the following Gnani AI models:

| Model                  | Type                 | Key Feature                                             | Access Method                                                           |
| ---------------------- | -------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Prisma v2.5 / v3.0** | Speech-to-Text (STT) | 10+ Indian languages, code-mixed, sub-200ms streaming   | API platform at app.gnani.ai/voice — credits apply                      |
| **Timbre v2.5 / v3.0** | Text-to-Speech (TTS) | 10+ Indian languages, 42 voices (v2.5), natural prosody | API platform at app.gnani.ai/voice — credits apply                      |
| **Evon v3.3**          | Language Model (LLM) | 30B parameters, 128K context, 11 Indian languages       | **SELF-HOSTED ONLY** — open weights on HuggingFace; NOT on API platform |

**CORRECTION NOTE [Audit Nov 1]**: The official hackathon blog explicitly states: "Prisma and Timbre run on the API platform at app.gnani.ai/voice, where your credits apply. Evon v3.3 isn't on the API platform yet: request the open weights on Hugging Face and run it yourself." [VERIFIED] This means:

- 5,000 programme credits = Prisma + Timbre usage ONLY
- Evon requires self-hosting on NVIDIA H100/A100 hardware
- The requirement is "at least one Gnani AI model" — Prisma + Timbre alone satisfy this requirement
- Using all three models is still the strongest strategy for award eligibility, but Evon requires separate hardware

**Strategy note for NammaOps**: Using Prisma (STT) + a fallback reasoning model + Timbre (TTS) satisfies the competition requirement. If H100 GPU access is available, self-hosting Evon strengthens the "deep integration" case. If not, disclose the fallback model transparently. [UPDATED — VERIFIED]

---

## 6. Submission Requirements

[VERIFIED FROM OFFICIAL SOURCE]

The final submission (by November 10, 2026, 11:59 PM IST) must include:

1. **Working demo or video** demonstrating the application
2. **Written project explanation** including:
   - Project title
   - Problem statement
   - Target users
   - Each member's individual contributions
3. **Models/APIs used**: Named identification of which Gnani AI models were integrated
4. **Social media post links**: At least one nominated post per platform used (LinkedIn and/or X)
5. **Documentation**: Project can be updated until final submission

**What constitutes a "working demo"**: [INFERRED] The competition language says "working application" and "working demo," implying the application must actually run and demonstrate real functionality, not a mockup or slides-only presentation.

---

## 7. LinkedIn and X (Twitter) Posting Requirements

[VERIFIED FROM OFFICIAL SOURCE]

**Required hashtags** (both must be used):

- `#GreatIndianAIInternshipChallenge`
- `#GnaniAI`

**Required actions:**

- Tag Gnani AI in the post [VERIFIED]
- Post must be live before final submission deadline [VERIFIED]
- Post on LinkedIn, X, or both [VERIFIED]
- The nominated post link(s) must be included in the submission form [VERIFIED]

**What the post must show**: A video demonstrating the working application. [VERIFIED — "Record video demonstrating the working application"]

**Engagement is evaluated**: Platform analyzes reactions, comments, and reshares on nominated posts. Higher engagement improves shortlisting probability. [VERIFIED]

**Crowd Favourite Award**: One of the ten awards is specifically for public votes on LinkedIn and X using the required hashtags. [VERIFIED]

---

## 8. Shortlisting Process (Engagement Verification + Interview)

[VERIFIED FROM OFFICIAL SOURCE]

The selection process has five stages:

1. **Public demo posting**: Participant posts on LinkedIn/X with required hashtags and tags.
2. **Engagement verification**: Platform analyzes reactions, comments, reshares on nominated posts. This is explicitly stated as part of shortlisting criteria.
3. **Eligibility check**: Confirms authentic use of Gnani technology and rule compliance.
4. **Shortlisting**: Projects with strongest verified engagement advance to interviews.
5. **Individual interviews**: All shortlisted participants are interviewed one-on-one.
6. **Written offers**: Based on assessed skills, interview performance, and role fit.

**Important nuance**: The competition states "authentic use of Gnani technology" as a shortlisting criterion [VERIFIED], meaning engagement alone is insufficient — the technical depth of the integration matters.

**Full-time consideration**: [VERIFIED] "High performers may be considered for full-time roles" — not guaranteed, but mentioned.

---

## 9. All Ten Award Categories

[VERIFIED FROM OFFICIAL SOURCE — gnani.ai/resources/blogs/great-indian-ai-internship-challenge-2026]

Each award is worth ₹50,000. Maximum one award per individual/team. Award judging is independent of internship consideration.

---

### Award 1: Main Character Award

**Description**: Best project in a regional or low-resource Indian language
**What is rewarded**: Demonstrating that Gnani's models can serve speakers of languages beyond Hindi/English — particularly underserved regional languages
**Criteria** [INFERRED from name and description]: Depth of language-specific work, actual functionality in the target language, quality of transcription/synthesis, impact on speakers of that language
**What NammaOps needs**: Strong Kannada-language functionality; the store management domain is directly relevant to rural/Tier-2 Kannada-speaking regions
**Competitiveness**: HIGH — NammaOps targets Kannada as primary language

---

### Award 2: Mixed Vibes Award

**Description**: Best code-mixed voice application (Hinglish, Tanglish, Benglish)
**What is rewarded**: Applications that work with natural code-mixing — the way Indians actually speak
**Criteria** [INFERRED]: Quality of code-mixed transcription handling, naturalness of mixed-language output, demonstrated understanding of the linguistic phenomenon
**What NammaOps needs**: Support for "Kannada-English" (Kanglish) and Hindi-English (Hinglish) kirana owner speech; realistic test cases showing accurate transcription of "ek kilo tomato hai kya?" type queries
**Competitiveness**: HIGH — Kirana store speech is inherently code-mixed

---

### Award 3: Real Deal Award

**Description**: Most useful solution for farmers, kirana stores, or rural healthcare
**What is rewarded**: Practical real-world utility; the award description explicitly names **kirana stores** as a target
**Criteria** [INFERRED]: Genuine utility for real users, not just a technical demo; measurable benefit; plausibility of actual deployment
**What NammaOps needs**: A demo scenario that shows a real kirana store problem being solved; ideally with a real or simulated kirana owner persona
**Competitiveness**: VERY HIGH — NammaOps is purpose-built for this exact category; kirana stores are named verbatim

---

### Award 4: Noise Canceller Award

**Description**: Best performance on messy telephonic audio
**What is rewarded**: Robustness of the STT integration under real-world noisy conditions (market sounds, phone calls, overlapping speech)
**Criteria** [INFERRED]: Demonstrated accuracy on noisy audio; test scenarios with realistic background noise; comparison metrics if possible
**What NammaOps needs**: Test scenarios with kirana store background noise (market sounds, TV in background, poor network); Prisma is specifically trained on telephony audio
**Competitiveness**: MEDIUM — Requires deliberate testing and demo design; Prisma's telephony training is a technical advantage

---

### Award 5: Two-Person Army Award

**Description**: Best project by a two-member team
**What is rewarded**: Quality of the project combined with it being built by exactly two people
**Criteria** [INFERRED]: Same as general quality, but restricted to team entries
**What NammaOps needs**: Being a two-member team; clear documentation of each person's contribution
**Competitiveness**: If submitting as a two-person team: MEDIUM-HIGH (depends on competition field)

---

### Award 6: Solo Ninja Award

**Description**: Best solo participant project
**What is rewarded**: Exceptional achievement by a single developer
**Criteria** [INFERRED]: Same quality bar as Two-Person Army, restricted to solo entries
**What NammaOps needs**: If submitting solo: must meet the same quality bar
**Competitiveness**: If submitting solo: MEDIUM-HIGH

---

### Award 7: Jugaad Genius Award

**Description**: Most creative or unexpected usage of the Gnani AI models
**What is rewarded**: Innovation, creativity, unexpected applications that judges find surprising
**Criteria** [INFERRED]: Novelty of use case; creative model combination; unexpected domain application
**What NammaOps needs**: The multi-agent orchestration architecture applied to voice-first kirana store operations is genuinely novel; emphasize the AI workforce metaphor as creative
**Competitiveness**: MEDIUM — Other entrants may target this directly; NammaOps's novelty is the multi-agent angle

---

### Award 8: Small Town, Big Build Award

**Description**: Best entry from a Tier 2/3 city or college
**What is rewarded**: Geographic diversity; talent from smaller cities and colleges
**Criteria** [INFERRED]: Registration address/college location must be in a Tier 2/3 city or college
**What NammaOps needs**: If team members are from Tier 2/3 cities — directly qualifies; this is a demographic criterion not a technical one
**Competitiveness**: DEPENDS ON TEAM LOCATION

---

### Award 9: Demo Day Drop Award

**Description**: Best 60-second demo video
**What is rewarded**: Production quality, clarity, and impact of the 60-second demonstration video
**Criteria** [INFERRED]: Video quality, clarity of problem/solution communication, technical demonstration clarity, memorability
**What NammaOps needs**: A polished 60-second video showing: (1) real voice input in Kannada/Hindi, (2) real processing, (3) real business result; tight narrative
**Competitiveness**: HIGH — A well-produced voice-first demo with real-time agent orchestration is visually compelling

---

### Award 10: Crowd Favourite Award

**Description**: Public votes on LinkedIn and X using the required hashtags
**What is rewarded**: The project that receives the most authentic public engagement on social media
**Criteria** [VERIFIED]: Public reactions, comments, reshares on nominated posts; bots and purchased engagement are disqualifying
**What NammaOps needs**: A compelling, shareable demo video that resonates with the developer community and kirana business community; content about solving real Indian small business problems tends to perform well
**Competitiveness**: MEDIUM — Depends heavily on network and posting strategy; the kirana store audience is large but requires reaching beyond the tech community

---

## 10. Prohibited Activities

[VERIFIED FROM OFFICIAL SOURCE]

The following activities result in disqualification:

| Prohibited Activity                                                             | Source                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Purchased engagement (paying for likes/comments/shares)                         | gnani.ai/internship [VERIFIED]                                                |
| Bots (automated social media engagement)                                        | gnani.ai/internship [VERIFIED]                                                |
| Paid promotion on social media platforms                                        | gnani.ai/internship [VERIFIED]                                                |
| Engagement exchanges ("like for like" schemes)                                  | gnani.ai/internship [VERIFIED]                                                |
| Plagiarism (submitting others' work as your own)                                | gnani.ai/internship [VERIFIED]                                                |
| Misleading/fake demonstrations                                                  | gnani.ai/internship [VERIFIED]                                                |
| Using real personal data (Aadhaar, PAN, phone numbers, recorded calls) in demos | gnani.ai/resources/blogs [VERIFIED]                                           |
| Missing the submission deadline                                                 | gnani.ai/internship [VERIFIED — "no extensions"]                              |
| Not using any Gnani AI model                                                    | gnani.ai/internship [VERIFIED]                                                |
| Submitting multiple entries                                                     | gnani.ai/internship [VERIFIED — "each person/team can submit only one entry"] |

---

## 11. IP, Originality, and Authenticity Requirements

[VERIFIED / INFERRED as noted]

**Originality**: Submissions must be original work by the named participants. Plagiarism results in disqualification. [VERIFIED]

**Authentic Gnani usage**: The eligibility check specifically verifies "authentic use of Gnani technology." This means the integration must be real and functional, not faked. [VERIFIED]

**Synthetic data for demos**: The competition explicitly requires synthetic data in demonstrations — no real personal data of real people. This means NammaOps demos should use fictional kirana store names, fictional supplier names, and fictional inventory data. [VERIFIED]

**IP ownership**: [UNVERIFIED ASSUMPTION — no specific IP clause was found in the verified sources] It is standard practice for hackathons to allow participants to retain IP. However, this was not explicitly confirmed in the sources reviewed. Participants should review the full terms of service on gnani.ai before submission.

**Build window**: The build window opens October 1, 2026. [VERIFIED — from the timeline] Work done before this date may need to be disclosed. [INFERRED]

---

## 12. Master Compliance Checklist

Use this before final submission. Every item maps to a verified rule.

### Technical Integration

- [ ] At least one Gnani AI model (Prisma/Timbre/Evon) is integrated [MUST — VERIFIED]
- [ ] All three Gnani models integrated (Prisma + Timbre + Evon) [STRONGLY RECOMMENDED — INFERRED]
- [ ] Integration is real and functional, not simulated [MUST — VERIFIED]
- [ ] Demo shows authentic Gnani API calls in action [MUST — VERIFIED]

### Submission Content

- [ ] Demo video recorded showing working application [MUST — VERIFIED]
- [ ] Project title documented [MUST — VERIFIED]
- [ ] Problem statement written [MUST — VERIFIED]
- [ ] Target users identified [MUST — VERIFIED]
- [ ] Each team member's individual contributions stated [MUST — VERIFIED]
- [ ] All Gnani models/APIs used are named in submission [MUST — VERIFIED]
- [ ] Submission updated before November 10, 2026, 11:59 PM IST [MUST — VERIFIED]

### Data Compliance

- [ ] No real phone numbers in demo [MUST — VERIFIED]
- [ ] No real Aadhaar numbers in demo [MUST — VERIFIED]
- [ ] No real PAN numbers in demo [MUST — VERIFIED]
- [ ] No real bank account numbers in demo [MUST — VERIFIED]
- [ ] No real recorded calls used in demo [MUST — VERIFIED]
- [ ] All store names, supplier names, and inventory data in demo are synthetic/fictional [MUST — VERIFIED]

### Social Media

- [ ] Demo video posted on LinkedIn and/or X [MUST — VERIFIED]
- [ ] Both hashtags used: #GreatIndianAIInternshipChallenge and #GnaniAI [MUST — VERIFIED]
- [ ] Gnani AI tagged in post [MUST — VERIFIED]
- [ ] Post is live before final submission [MUST — VERIFIED]
- [ ] Post link(s) included in submission form [MUST — VERIFIED]
- [ ] No purchased engagement, bots, or paid promotion used [MUST — VERIFIED]
- [ ] No engagement exchanges arranged [MUST — VERIFIED]

### Eligibility

- [ ] All team members currently enrolled in an Indian college/university [MUST — VERIFIED]
- [ ] All team members 18+ years old at registration [MUST — VERIFIED]
- [ ] Team has maximum 2 members [MUST — VERIFIED]
- [ ] This is the only submission from this team/individual [MUST — VERIFIED]

### Award Targeting

- [ ] Identified primary award category to target [RECOMMENDED — INFERRED]
- [ ] Documented which award criteria each feature addresses [RECOMMENDED — INFERRED]

---

## 13. Legitimate Public Engagement Strategy

The competition explicitly rewards authentic engagement and explicitly prohibits purchased, automated, or exchanged engagement. The following strategies are compliant and effective:

**Before posting:**

- Prepare a visually compelling 60-second video that tells a story people want to share
- Include captions/subtitles in the video (many mobile users watch with sound off)
- Choose posting time: 8–9 AM or 6–8 PM IST on weekdays for maximum organic reach [INFERRED — general social media best practice]
- Prepare a clear LinkedIn post text explaining the problem being solved (kirana store challenges resonate broadly in India)

**Legitimate engagement tactics:**

- Share with personal networks: college friends, professors, alumni LinkedIn connections
- Post in relevant communities: college WhatsApp/Telegram groups (personal messaging, not spam)
- Engage with other hackathon participants' posts authentically (genuine comments)
- Ask professors or mentors to share if they find it genuinely interesting
- Respond to every comment on your post (boosts algorithm reach organically)
- Cross-post across personal LinkedIn and X for reach

**Content strategy for NammaOps:**

- Frame the story around the kirana owner (13+ million in India), not the technology
- Show the contrast: "Before NammaOps" (paper ledger, calling supplier manually) vs. "After NammaOps" (voice command, instant result)
- Include a line in Kannada or Hindi in the post — relatable to the target audience
- Tag relevant communities: MSME associations, startup communities, college entrepreneurship cells

**What to avoid:**

- Asking people to "like this post" in exchange for anything
- Using any third-party engagement service or tool
- Creating multiple accounts to engage with your own post
- Posting in groups that explicitly prohibit promotional content

---

## 14. What Could NOT Be Verified (Updated by Audit Nov 1)

**CORRECTION NOTE [Audit Nov 1]**: Several previously unverified items have been resolved. Table updated.

| Item                                               | Status After Audit                                                                                                                                             | Risk Level                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Full terms and conditions / IP ownership clause    | STILL UNVERIFIED — review before submission                                                                                                                    | MEDIUM                          |
| Exact judging rubric for each award category       | STILL UNVERIFIED — only category names and brief descriptions available                                                                                        | HIGH                            |
| Credit consumption rate per Prisma/Timbre API call | STILL UNVERIFIED — must test on Day 1; credits do NOT cover Evon                                                                                               | MEDIUM                          |
| Evon API platform access                           | **RESOLVED [Audit Nov 1]**: Evon is self-hosted open weights ONLY, NOT on API platform                                                                         | RESOLVED — affects architecture |
| Whether programme credits cover v3.0 models        | STILL UNVERIFIED — Prisma v3.0 launched Oct 28; LiveKit docs list it; confirm via app.gnani.ai/voice                                                           | MEDIUM                          |
| Late submission grace period                       | STILL UNVERIFIED — treat as hard deadline                                                                                                                      | LOW                             |
| Judging panel composition                          | STILL UNVERIFIED                                                                                                                                               | LOW                             |
| Actual Prisma/Timbre API endpoints                 | **RESOLVED [Audit Nov 1]**: STT WebSocket: `wss://api.vachana.ai/stt/v3/stream`; TTS WebSocket: `wss://api.vachana.ai/api/v1/tts`; Auth: `X-API-Key-ID` header | RESOLVED                        |
| Exact engagement metrics for shortlisting          | STILL UNVERIFIED — "platform analyzes reactions, comments, reshares"                                                                                           | MEDIUM                          |
