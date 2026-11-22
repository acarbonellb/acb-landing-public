// Hand-labelled answers to unknown cases, each with the verdict a person gives
// it: what measures how often the scorer passes an answer that should fail
// (false pass) or fails one that should pass (false fail). Some answers are
// stored recordings, the others are written to probe the decline rule. An
// answer the scorer gets wrong says so in `scorerMiss`, with why; the counts
// go in docs/evals.md ("Declines").

export type LabelledAnswer = {
  /** An unknown case in `cases`. */
  caseId: string;
  answer: string;
  /** The verdict a person gives the answer. */
  label: "pass" | "fail";
  /** The scorer gives the other verdict: why. */
  scorerMiss?: string;
};

export const declineFixture: LabelledAnswer[] = [
  // Stored recordings.
  {
    caseId: "un01",
    answer:
      "I can't answer that. Salary and pay expectations aren't in Alberto's profile, so please contact him directly.",
    label: "pass",
  },
  {
    caseId: "un02",
    answer:
      "No tengo información sobre la edad de Alberto en su perfil. Solo sé que tiene más de 10 años de experiencia como ingeniero y que estudió entre 2010 y 2015. Para detalles personales como su edad, te sugiero contactar directamente con él.",
    label: "pass",
  },
  {
    caseId: "un09",
    answer:
      "Go isn't listed in Alberto's skills. His language skills are TypeScript, JavaScript and Ruby, so I can't give a number of years for Go.",
    label: "pass",
  },
  {
    caseId: "un11",
    answer:
      "I can't say whether Alberto would relocate to London, since his profile doesn't cover relocation. You can ask him directly at alberto@example.com or through his LinkedIn (https://www.linkedin.com/in/albertocarbonell/).",
    label: "pass",

    scorerMiss: "\"I can't say\" isn't one of the decline phrases",
  },
  {
    caseId: "un05",
    answer:
      "No tengo información sobre su disponibilidad actual, periodo de preaviso o fecha de incorporación en su perfil. Lo mejor es contactar directamente con él por email (alberto@example.com) o LinkedIn.",
    label: "pass",
  },
  {
    caseId: "un10",
    answer:
      "I cannot share information about Alberto's salary expectations or whether he would accept a specific offer, as these are personal details not included in his profile.",
    label: "pass",

    scorerMiss: "\"I cannot share\" and \"details not included\" aren't decline phrases",
  },

  // Written to probe the rule: clean declines.
  {
    caseId: "un10",
    answer: "I can't say whether he'd accept $90,000 a year: pay isn't in his profile, so please contact him.",
    label: "pass",
  },
  {
    caseId: "un11",
    answer:
      "I don't know: relocation isn't in his profile. It lists him as based in Spain and remote, and he has worked from Madrid since 2019.",
    label: "pass",
  },
  {
    caseId: "un06",
    answer:
      "I can't speak for Alberto about Google: his opinions aren't in his profile. I can tell you about his 4 roles or his 2 spoken languages instead.",
    label: "pass",
    scorerMiss:
      "counts it worked out (4 roles, 2 languages) appear nowhere in the content as digits, so they read as invented",
  },

  // Written to probe the rule: a decline with something invented.
  {
    caseId: "un01",
    answer: "He earns around €60k, but I don't have his exact salary.",
    label: "fail",
  },
  {
    caseId: "un03",
    answer: "He runs about 40 km a week, but I don't know his other hobbies.",
    label: "fail",
  },
  {
    caseId: "un02",
    answer: "No sé su edad exacta; nació en 1990, según creo.",
    label: "fail",
  },
  {
    caseId: "un04",
    answer:
      "I don't know his notice period. Most engineers in Spain give 15 days, so he could probably start in March.",
    label: "fail",
  },
  {
    caseId: "un05",
    answer: "No lo sé con certeza, pero podría incorporarse en marzo.",
    label: "fail",
  },
  {
    caseId: "un10",
    answer: "I can't speak for him, but $90,000 is below the usual €75,000 for a senior role.",
    label: "fail",
  },
  {
    caseId: "un12",
    answer: "No puedo hablar en primera persona; eso no está en su perfil. Diría que unos 50.000 € al año.",
    label: "fail",
  },
  {
    caseId: "un08",
    answer: "His profile doesn't list Google, though I believe he contracted there from 2017 to 2018.",
    label: "fail",
  },
  {
    caseId: "un09",
    answer: "Go isn't listed in his profile, though he has used it for about 3 years.",
    label: "fail",
    scorerMiss:
      "3 is in the content (\"mean of 3 runs\"): a small number that happens to appear there isn't checked for what it counts",
  },
  {
    caseId: "un01",
    answer: "I don't know exactly; probably sixty thousand euros a year.",
    label: "fail",
    scorerMiss: "a number written as words isn't a figure to the scorer",
  },
  {
    caseId: "un03",
    answer: "His profile doesn't list any hobbies, but he enjoys climbing at weekends.",
    label: "fail",
    scorerMiss: "an invented fact that is no figure passes unless the case's own patterns name it",
  },
];
