"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export const locales = ["en", "ar"] as const;

export type Locale = (typeof locales)[number];

type Translation = {
  theme: {
    label: string;
    light: string;
    dark: string;
    system: string;
  };
  languageSwitcher: {
    label: string;
    english: string;
    arabic: string;
  };
  login: {
    eyebrow: string;
    title: string;
    description: string;
    formTitle: string;
    formDescription: string;
    emailLabel: string;
    passwordLabel: string;
    submit: string;
    submitting: string;
    missingCredentials: string;
    invalidCredentials: string;
    unavailable: string;
    showPassword: string;
    hidePassword: string;
    featureInterviews: string;
    featureEvaluations: string;
    featureSecurity: string;
    platformCaption: string;
  };
  dashboard: {
    loading: string;
    accessUnavailable: string;
    returnToLogin: string;
    welcome: string;
    logout: string;
    loggingOut: string;
    sessionLoadFailed: string;
    connectionUnavailable: string;
    sessionReloadRequired: string;
    logoutFailed: string;
  };
  navigation: {
    workspace: string;
    menu: string;
    closeMenu: string;
    collapseSidebar: string;
    expandSidebar: string;
    overview: string;
    candidates: string;
    interviews: string;
    recordings: string;
    evaluations: string;
    settings: string;
  };
  overview: {
    eyebrow: string;
    title: string;
    description: string;
    totalCandidates: string;
    scheduledInterviews: string;
    completedInterviews: string;
    pendingEvaluations: string;
    noData: string;
    recentActivity: string;
    recentActivityDescription: string;
    noActivity: string;
    interviewStatus: string;
    completed: string;
    inProgress: string;
    scheduled: string;
    quickAccess: string;
    quickAccessDescription: string;
    viewCandidates: string;
    viewInterviews: string;
    viewEvaluations: string;
    viewRecordings: string;
    activeCandidateProfiles: string;
    upcomingSessions: string;
    completedRecordings: string;
    inProgressSessions: string;
  };
  candidates: {
    title: string;
    description: string;
    addCandidate: string;
    candidateList: string;
    givenName: string;
    familyName: string;
    email: string;
    create: string;
    creating: string;
    noCandidates: string;
    loadFailed: string;
    createFailed: string;
    emailExists: string;
    searchPlaceholder: string;
    noSearchResults: string;
    noSearchResultsDescription: string;
    statusActive: string;
    createdAt: string;
    actions: string;
    totalCandidatesCount: string;
  };
  interviews: {
    title: string;
    description: string;
    createSession: string;
    candidate: string;
    selectCandidate: string;
    create: string;
    creating: string;
    noCandidates: string;
    noSessions: string;
    loadFailed: string;
    createFailed: string;
    status: string;
    created: string;
    viewDetails: string;
    details: string;
    futureRoom: string;
    futureRoomDescription: string;
    openRoom: string;
    scheduled: string;
    inProgress: string;
    completed: string;
    cancelled: string;
    failed: string;
    recording: string;
    recordingPrivate: string;
    recordingLoading: string;
    recordingAvailable: string;
    recordingNotSaved: string;
    recordingLoadFailed: string;
    roomCompletedTitle: string;
    roomCompletedDescription: string;
    requiredLevel: string;
    notConfigured: string;
    backToInterviews: string;
    searchPlaceholder: string;
    noMatchingSessions: string;
    totalSessions: string;
  };
  evaluations: {
    title: string;
    description: string;
    searchPlaceholder: string;
    filterAll: string;
    filterCompleted: string;
    filterPending: string;
    filterInsufficient: string;
    filterFailed: string;
    totalEvaluated: string;
    averageScore: string;
    insufficientEvidence: string;
    pendingCount: string;
    noEvaluations: string;
    noEvaluationsDescription: string;
    noMatchingEvaluations: string;
    viewFullReport: string;
    retryAssessment: string;
  };
  recordingsWorkspace: {
    title: string;
    description: string;
    searchPlaceholder: string;
    candidateFolders: string;
    oneRecording: string;
    twoRecordings: string;
    multipleRecordings: string;
    noCandidatesWithRecordings: string;
    noCandidatesDescription: string;
    noSearchResults: string;
    noSearchResultsDescription: string;
    backToFolders: string;
    folderTitle: string;
    folderEmpty: string;
    folderEmptyDescription: string;
    loadFailed: string;
    folderLoadFailed: string;
    retry: string;
    recordedAt: string;
    interviewStatus: string;
    storageStatus: string;
    evaluationStatus: string;
    score: string;
    noScore: string;
    pendingEvaluation: string;
    level: string;
    summary: string;
    watchVideo: string;
    hideVideo: string;
    loadingVideo: string;
    videoLoadFailed: string;
    duration: string;
    fileSize: string;
    transcriptTitle: string;
    viewTranscript: string;
    hideTranscript: string;
    loadingTranscript: string;
    transcriptLoadFailed: string;
    noTranscript: string;
    candidateSpeaker: string;
    interviewerSpeaker: string;
    systemSpeaker: string;
    germanOriginal: string;
    assessmentTitle: string;
    assessmentSubtitle: string;
    assessmentStatus: string;
    statusPending: string;
    statusAnalyzing: string;
    statusCompleted: string;
    statusInsufficient: string;
    statusFailed: string;
    retryingAssessment: string;
    pendingPollingHint: string;
    insufficientEvidenceNotice: string;
    failedNotice: string;
    failedExplanation: string;
    assessmentLoadFailed: string;
    claimedLevel: string;
    claimedLevelHint: string;
    notSpecified: string;
    assessedLevel: string;
    assessedLevelHint: string;
    overallScore: string;
    requiredLevel: string;
    notConfigured: string;
    updatingRequirement: string;
    updateRequirementFailed: string;
    recommendation: string;
    meetsRequirement: string;
    belowRequirement: string;
    insufficientRecommendation: string;
    notConfiguredRecommendation: string;
    strengthsTitle: string;
    areasForImprovementTitle: string;
    criteriaTitle: string;
    notAssessed: string;
    acousticAnalysisRequired: string;
    evidenceTitle: string;
    evidenceSubtitle: string;
    turn: string;
    quote: string;
    observation: string;
    hideEvidence: string;
    showEvidence: string;
  };
  room: {
    title: string;
    loading: string;
    sessionUnavailable: string;
    returnToDetails: string;
    deviceSetup: string;
    deviceSetupDescription: string;
    camera: string;
    microphone: string;
    selectCamera: string;
    selectMicrophone: string;
    noCamera: string;
    noMicrophone: string;
    enableDevices: string;
    retryDevices: string;
    permissionDenied: string;
    permissionDeniedDescription: string;
    deviceError: string;
    deviceErrorDescription: string;
    candidatePreview: string;
    cameraOff: string;
    aiInterviewer: string;
    aiInterviewerDescription: string;
    microphoneActivity: string;
    cameraStatus: string;
    microphoneStatus: string;
    on: string;
    off: string;
    connection: string;
    notConnected: string;
    connectionIdle: string;
    connectionConnecting: string;
    connectionConnected: string;
    connectionEnding: string;
    connectionEnded: string;
    connectionFailed: string;
    connectionError: string;
    microphoneUnavailable: string;
    secureSessionUnavailable: string;
    connectionNotAuthorized: string;
    serviceNotConfigured: string;
    connectionFailedMessage: string;
    connectionTimedOut: string;
    connectionInterrupted: string;
    audioPlaybackFailed: string;
    aiSpeaking: string;
    aiListening: string;
    candidateSpeaking: string;
    candidateListening: string;
    deviceTestTimer: string;
    interviewTimer: string;
    startInterview: string;
    startInterviewDescription: string;
    endInterview: string;
    recording: string;
    recordingReady: string;
    recordingInProgress: string;
    recordingUploading: string;
    recordingSaved: string;
    recordingFailed: string;
    recordingError: string;
    recordingStartFailed: string;
    recordingUploadFailed: string;
    instructionsTitle: string;
    instructions: string;
    alreadyCompletedTitle: string;
    alreadyCompletedDescription: string;
    alreadyRecordedError: string;
    maxDurationNotice: string;
    guidelines: string;
    guidelinesAcknowledge: string;
    guidelineGermanOnly: string;
    guidelineTimeLimit: string;
    guidelineDevices: string;
    guidelineIndependent: string;
    guidelinesRequired: string;
    devicesPreparing: string;
    cameraReady: string;
    microphoneReady: string;
    deviceLostDuringInterview: string;
    retryRecordingUpload: string;
    interviewEnding: string;
  };
  emptyStates: {
    evaluations: { title: string; description: string };
    settings: { title: string; description: string };
  };
  authorization: {
    checking: string;
    unavailable: string;
  };
  accessDenied: {
    title: string;
    description: string;
    returnToDashboard: string;
  };
  roles: {
    admin: string;
    clientReviewer: string;
  };
};

export const translations: Record<Locale, Translation> = {
  en: {
    theme: {
      label: "Theme",
      light: "Light",
      dark: "Dark",
      system: "System",
    },
    languageSwitcher: {
      label: "Application language",
      english: "English",
      arabic: "Arabic",
    },
    login: {
      eyebrow: "Vervio",
      title: "Secure access for your recruitment team.",
      description:
        "Sign in to access information that has been authorized for your company.",
      formTitle: "Sign in",
      formDescription: "Your access is managed by Vervio.",
      emailLabel: "Email address",
      passwordLabel: "Password",
      submit: "Sign in",
      submitting: "Signing in…",
      missingCredentials: "Enter your email address and password.",
      invalidCredentials: "The email address or password is incorrect.",
      unavailable: "Sign-in is unavailable right now. Please try again.",
      showPassword: "Show password",
      hidePassword: "Hide password",
      featureInterviews: "AI-led, candidate-focused German interview sessions",
      featureEvaluations: "Objective, evidence-based CEFR German evaluations",
      featureSecurity: "Secure access to recordings and transcripts",
      platformCaption: "Vervio Platform · Secure German Interview Assessment",
    },
    dashboard: {
      loading: "Restoring your secure workspace…",
      accessUnavailable: "Access is currently unavailable",
      returnToLogin: "Return to sign in",
      welcome: "Welcome, {name}",
      logout: "Log out",
      loggingOut: "Logging out…",
      sessionLoadFailed: "Your session could not be loaded.",
      connectionUnavailable: "The server connection is currently unavailable.",
      sessionReloadRequired: "Your session must be refreshed before you log out.",
      logoutFailed: "Logout could not be completed. Please try again.",
    },
    navigation: {
      workspace: "Workspace",
      menu: "Open navigation",
      closeMenu: "Close navigation",
      collapseSidebar: "Collapse sidebar",
      expandSidebar: "Expand sidebar",
      overview: "Overview",
      candidates: "Candidates",
      interviews: "Interviews",
      recordings: "Recordings",
      evaluations: "Evaluations",
      settings: "Settings",
    },
    overview: {
      eyebrow: "Workspace overview",
      title: "Recruitment at a glance",
      description: "A clear view of your Vervio workspace as activity becomes available.",
      totalCandidates: "Total candidates",
      scheduledInterviews: "Scheduled interviews",
      completedInterviews: "Completed interviews",
      pendingEvaluations: "Pending evaluations",
      noData: "No data available yet",
      recentActivity: "Recent activity",
      recentActivityDescription: "Workspace updates will appear here as they happen.",
      noActivity: "There is no activity to show yet.",
      interviewStatus: "Interview status overview",
      completed: "Completed",
      inProgress: "In progress",
      scheduled: "Scheduled",
      quickAccess: "Quick access",
      quickAccessDescription: "Go directly to the areas you need most.",
      viewCandidates: "Open candidates",
      viewInterviews: "Open interviews",
      viewEvaluations: "Open evaluations",
      viewRecordings: "Open recordings",
      activeCandidateProfiles: "Active candidate profiles",
      upcomingSessions: "Upcoming German sessions",
      completedRecordings: "Audio & transcripts ready",
      inProgressSessions: "Currently active interviews",
    },
    candidates: {
      title: "Candidates",
      description: "Add the basic information needed to prepare a German interview.",
      addCandidate: "Add candidate",
      candidateList: "Candidate list",
      givenName: "Given name",
      familyName: "Family name",
      email: "Email address",
      create: "Create candidate",
      creating: "Creating candidate…",
      noCandidates: "No candidates have been added yet.",
      loadFailed: "Candidates could not be loaded.",
      createFailed: "Candidate creation could not be completed.",
      emailExists: "A candidate with this email already exists.",
      searchPlaceholder: "Search candidates by name or email…",
      noSearchResults: "No matching candidates found",
      noSearchResultsDescription: "Try a different search term or clear the filter.",
      statusActive: "Active",
      createdAt: "Added",
      actions: "Actions",
      totalCandidatesCount: "{count} candidates",
    },
    interviews: {
      title: "Interviews",
      description: "Create and review candidate-linked interview sessions.",
      createSession: "Create interview session",
      candidate: "Candidate",
      selectCandidate: "Select a candidate",
      create: "Create session",
      creating: "Creating session…",
      noCandidates: "Add a candidate before creating an interview session.",
      noSessions: "No interview sessions have been created yet.",
      loadFailed: "Interview sessions could not be loaded.",
      createFailed: "Interview session creation could not be completed.",
      status: "Status",
      created: "Created",
      viewDetails: "View details",
      details: "Interview session details",
      futureRoom: "Interview room",
    futureRoomDescription: "Prepare devices and start the live German AI interview from this secure room.",
      openRoom: "Open Interview Room",
      scheduled: "Scheduled",
      inProgress: "In progress",
      completed: "Completed",
      cancelled: "Cancelled",
      failed: "Failed",
      recording: "Interview recording",
      recordingPrivate: "Available only through this authorized Vervio session.",
      recordingLoading: "Loading recording…",
      recordingAvailable: "Private recording ready",
      recordingNotSaved: "No recording saved",
      recordingLoadFailed: "Recording unavailable",
      roomCompletedTitle: "Interview completed",
      roomCompletedDescription:
        "This interview session has concluded and its recording is saved. No further recording can be made.",
      requiredLevel: "Required German level",
      notConfigured: "Not configured",
      backToInterviews: "Back to interviews",
      searchPlaceholder: "Search sessions by candidate name or status…",
      noMatchingSessions: "No matching interview sessions found",
      totalSessions: "{count} sessions",
    },
    evaluations: {
      title: "Evaluations",
      description: "Evidence-based German language assessment results and candidate proficiency ratings.",
      searchPlaceholder: "Filter evaluations by candidate name or email…",
      filterAll: "All assessments",
      filterCompleted: "Completed",
      filterPending: "Pending",
      filterInsufficient: "Insufficient evidence",
      filterFailed: "Failed",
      totalEvaluated: "Total evaluated",
      averageScore: "Average score",
      insufficientEvidence: "Insufficient evidence",
      pendingCount: "Pending analysis",
      noEvaluations: "No assessments available yet",
      noEvaluationsDescription: "Completed candidate interviews are automatically analyzed and evaluated for German proficiency.",
      noMatchingEvaluations: "No matching evaluations found",
      viewFullReport: "View recordings & evidence",
      retryAssessment: "Retry assessment",
    },
    recordingsWorkspace: {
      title: "Recordings Workspace",
      description:
        "Candidate virtual folders containing all recorded interviews and verified evaluations.",
      searchPlaceholder: "Search candidate by name or email…",
      candidateFolders: "Candidate Folders",
      oneRecording: "1 recording",
      twoRecordings: "2 recordings",
      multipleRecordings: "{count} recordings",
      noCandidatesWithRecordings: "No recorded interviews found",
      noCandidatesDescription:
        "Candidate folders will appear here once interview sessions are conducted and recordings are saved.",
      noSearchResults: "No matching folders found",
      noSearchResultsDescription: "Try searching with a different candidate name or email address.",
      backToFolders: "Back to candidate folders",
      folderTitle: "Candidate Interview Recordings",
      folderEmpty: "No recordings in this folder",
      folderEmptyDescription:
        "This candidate does not currently have any saved interview recordings.",
      loadFailed: "Recordings catalog could not be loaded.",
      folderLoadFailed: "Candidate recordings could not be loaded.",
      retry: "Retry",
      recordedAt: "Recorded at",
      interviewStatus: "Interview status",
      storageStatus: "Storage status",
      evaluationStatus: "Evaluation status",
      score: "Assessment Score",
      noScore: "Pending review",
      pendingEvaluation: "Language evaluation pending",
      level: "CEFR Level",
      summary: "Evaluation summary",
      watchVideo: "Watch recording",
      hideVideo: "Hide video",
      loadingVideo: "Loading secure recording…",
      videoLoadFailed: "Failed to load recording video.",
      duration: "Duration",
      fileSize: "File size",
      transcriptTitle: "Interview Transcript",
      viewTranscript: "View Transcript",
      hideTranscript: "Hide Transcript",
      loadingTranscript: "Loading transcript…",
      transcriptLoadFailed: "Failed to load interview transcript.",
      noTranscript: "No transcript available for this interview.",
      candidateSpeaker: "Candidate",
      interviewerSpeaker: "AI Interviewer",
      systemSpeaker: "System",
      germanOriginal: "Original German",
      assessmentTitle: "German AI Language Assessment",
      assessmentSubtitle: "Evidence-based evaluation of demonstrated German interview performance",
      assessmentStatus: "Assessment Status",
      statusPending: "Assessment pending",
      statusAnalyzing: "Analyzing interview…",
      statusCompleted: "Assessment completed",
      statusInsufficient: "Insufficient evidence",
      statusFailed: "Evaluation error",
      retryingAssessment: "Retrying assessment…",
      pendingPollingHint: "German interview evaluation is being generated automatically in the background. Polling for results…",
      insufficientEvidenceNotice: "This interview did not provide sufficient German candidate speech for a reliable language evaluation.",
      failedNotice: "An error occurred while evaluating the interview recording.",
      failedExplanation: "The language evaluation could not be completed. You can safely retry the assessment.",
      assessmentLoadFailed: "Failed to load assessment data.",
      claimedLevel: "Claimed Level (CV)",
      claimedLevelHint: "Self-reported on CV — does not influence AI assessment",
      notSpecified: "Not specified",
      assessedLevel: "Demonstrated CEFR Level",
      assessedLevelHint: "Independently measured by AI",
      overallScore: "Overall Proficiency Score",
      requiredLevel: "Required German Level",
      notConfigured: "Not configured",
      updatingRequirement: "Updating requirement…",
      updateRequirementFailed: "Failed to update required German level.",
      recommendation: "Language Recommendation",
      meetsRequirement: "Meets Requirement",
      belowRequirement: "Below Requirement",
      insufficientRecommendation: "Insufficient Evidence",
      notConfiguredRecommendation: "Requirement Not Configured",
      strengthsTitle: "Key Linguistic Strengths",
      areasForImprovementTitle: "Areas for Improvement",
      criteriaTitle: "Linguistic Criteria Assessment",
      notAssessed: "Not assessed",
      acousticAnalysisRequired: "Audio acoustic analysis required — not assessed from transcript",
      evidenceTitle: "Transcript-Backed Evidence",
      evidenceSubtitle: "Original German quotations and linguistic observations from candidate speech",
      turn: "Turn",
      quote: "Quotation",
      observation: "Observation",
      hideEvidence: "Hide Evidence",
      showEvidence: "Show Evidence ({count})",
    },
    room: {
      title: "Interview Room",
      loading: "Loading interview session…",
      sessionUnavailable: "This interview session is unavailable.",
      returnToDetails: "Return to interview details",
      deviceSetup: "Device setup",
      deviceSetupDescription:
        "Test the candidate camera and microphone before connecting to the live German AI interview.",
      camera: "Camera",
      microphone: "Microphone",
      selectCamera: "Select camera",
      selectMicrophone: "Select microphone",
      noCamera: "No camera was found.",
      noMicrophone: "No microphone was found.",
      enableDevices: "Enable camera and microphone",
      retryDevices: "Retry device setup",
      permissionDenied: "Camera or microphone permission was denied",
      permissionDeniedDescription:
        "Allow camera and microphone access in your browser, then retry the device setup.",
      deviceError: "Device setup could not be completed",
      deviceErrorDescription:
        "Check that a camera and microphone are connected, available, and not in use by another application.",
      candidatePreview: "Candidate camera preview",
      cameraOff: "Camera preview is off",
      aiInterviewer: "AI interviewer",
      aiInterviewerDescription:
        "The AI interviewer conducts the live conversation in German, independently of the application language.",
      microphoneActivity: "Microphone activity",
      cameraStatus: "Camera status",
      microphoneStatus: "Microphone status",
      on: "On",
      off: "Off",
      connection: "AI connection",
      notConnected: "Not connected",
      connectionIdle: "Ready to connect",
      connectionConnecting: "Connecting securely…",
      connectionConnected: "Connected — German voice interview is live",
      connectionEnding: "Ending the interview…",
      connectionEnded: "Interview ended",
      connectionFailed: "Connection failed",
      connectionError: "AI voice connection error",
      microphoneUnavailable: "Enable a working microphone before starting the interview.",
      secureSessionUnavailable: "Your secure session is unavailable. Please sign in again.",
      connectionNotAuthorized: "You are not authorized to start this interview.",
      serviceNotConfigured: "The AI voice service is not configured yet. Add the server-side Gemini configuration and try again.",
      connectionFailedMessage: "The AI voice connection could not be started. Please try again.",
      connectionTimedOut: "The AI voice connection timed out. Please try again.",
      connectionInterrupted: "The AI voice connection was interrupted.",
      audioPlaybackFailed: "The browser could not play the AI audio. Check its sound permissions and output device.",
      aiSpeaking: "AI interviewer is speaking",
      aiListening: "AI interviewer is listening",
      candidateSpeaking: "Candidate is speaking",
      candidateListening: "Candidate microphone is ready",
      deviceTestTimer: "Pre-interview device test",
      interviewTimer: "Active interview time",
      startInterview: "Start Interview",
      startInterviewDescription:
        "Starting begins private recording and connects the selected microphone to a live German AI interview. Demo sessions end automatically after two minutes. Camera video is not sent to the AI.",
      endInterview: "End Interview",
      recording: "Recording",
      recordingReady: "Starts with interview",
      recordingInProgress: "Recording both voices",
      recordingUploading: "Saving securely…",
      recordingSaved: "Saved privately",
      recordingFailed: "Recording failed",
      recordingError: "Interview recording error",
      recordingStartFailed: "The browser could not start a secure interview recording.",
      recordingUploadFailed: "The recording could not be saved securely. The interview itself was not marked complete.",
      instructionsTitle: "Before you begin",
      instructions:
        "Check framing, sound input, and device selection. Start only when the candidate is ready for a live German conversation. Recording starts only with the live interview. This version does not transcribe or evaluate the interview.",
      alreadyCompletedTitle: "Interview already completed",
      alreadyCompletedDescription:
        "This interview has already been conducted and recorded. Each interview session allows only one recording.",
      alreadyRecordedError:
        "This interview session already has a saved recording and cannot be re-recorded.",
      maxDurationNotice: "Maximum 2 minutes",
      guidelines: "Guidelines",
      guidelinesAcknowledge: "I understand — continue",
      guidelineGermanOnly: "Speak German only throughout the interview.",
      guidelineTimeLimit: "The live interview lasts up to 120 seconds.",
      guidelineDevices: "Keep the camera and microphone available for the full interview.",
      guidelineIndependent: "Answer independently, in your own words.",
      guidelinesRequired: "Review and acknowledge the interview guidelines before starting.",
      devicesPreparing: "Preparing camera and microphone…",
      cameraReady: "Camera ready",
      microphoneReady: "Microphone ready",
      deviceLostDuringInterview:
        "A required camera or microphone became unavailable. The interview is ending and the recording will be saved if possible.",
      retryRecordingUpload: "Retry secure upload",
      interviewEnding: "Ending and saving interview…",
    },
    emptyStates: {
      evaluations: {
        title: "No evaluations to show",
        description: "Evaluation reports will appear here when they are available for review.",
      },
      settings: {
        title: "Settings are not available yet",
        description: "Workspace administration settings will be introduced in a future stage.",
      },
    },
    authorization: {
      checking: "Checking your administration access…",
      unavailable: "Administration access is currently unavailable.",
    },
    accessDenied: {
      title: "Access denied",
      description:
        "Your account is not authorized for this area. Contact Vervio if you have questions.",
      returnToDashboard: "Return to dashboard",
    },
    roles: {
      admin: "Administrator",
      clientReviewer: "Client reviewer",
    },
  },
  ar: {
    theme: {
      label: "المظهر",
      light: "فاتح",
      dark: "داكن",
      system: "النظام",
    },
    languageSwitcher: {
      label: "لغة التطبيق",
      english: "الإنجليزية",
      arabic: "العربية",
    },
    login: {
      eyebrow: "Vervio",
      title: "وصول آمن لفريق التوظيف لديك.",
      description: "سجّل الدخول للوصول إلى المعلومات المصرّح بها لشركتك.",
      formTitle: "تسجيل الدخول",
      formDescription: "تتم إدارة صلاحية وصولك بواسطة Vervio.",
      emailLabel: "البريد الإلكتروني",
      passwordLabel: "كلمة المرور",
      submit: "تسجيل الدخول",
      submitting: "جارٍ تسجيل الدخول…",
      missingCredentials: "أدخل بريدك الإلكتروني وكلمة المرور.",
      invalidCredentials: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
      unavailable: "تسجيل الدخول غير متاح حالياً. يُرجى المحاولة مرة أخرى.",
      showPassword: "إظهار كلمة المرور",
      hidePassword: "إخفاء كلمة المرور",
      featureInterviews: "مقابلات ألمانية مدعومة بالذكاء الاصطناعي ومتمحورة حول المرشح",
      featureEvaluations: "تقييمات ألمانية موضوعية ومستندة إلى الأدلة وفق CEFR",
      featureSecurity: "وصول آمن إلى التسجيلات والنصوص",
      platformCaption: "منصة Vervio · تقييم آمن للمقابلات الألمانية",
    },
    dashboard: {
      loading: "جارٍ استعادة مساحة عملك الآمنة…",
      accessUnavailable: "الوصول غير متاح حالياً",
      returnToLogin: "العودة إلى تسجيل الدخول",
      welcome: "مرحباً، {name}",
      logout: "تسجيل الخروج",
      loggingOut: "جارٍ تسجيل الخروج…",
      sessionLoadFailed: "تعذر تحميل جلستك.",
      connectionUnavailable: "الاتصال بالخادم غير متاح حالياً.",
      sessionReloadRequired: "يجب تحديث جلستك قبل تسجيل الخروج.",
      logoutFailed: "تعذر إكمال تسجيل الخروج. يُرجى المحاولة مرة أخرى.",
    },
    navigation: {
      workspace: "مساحة العمل",
      menu: "فتح التنقل",
      closeMenu: "إغلاق التنقل",
      collapseSidebar: "طي الشريط الجانبي",
      expandSidebar: "توسيع الشريط الجانبي",
      overview: "نظرة عامة",
      candidates: "المرشحون",
      interviews: "المقابلات",
      recordings: "التسجيلات",
      evaluations: "التقييمات",
      settings: "الإعدادات",
    },
    overview: {
      eyebrow: "نظرة عامة على مساحة العمل",
      title: "التوظيف في لمحة",
      description: "عرض واضح لمساحة عمل Vervio مع توفر النشاط.",
      totalCandidates: "إجمالي المرشحين",
      scheduledInterviews: "المقابلات المجدولة",
      completedInterviews: "المقابلات المكتملة",
      pendingEvaluations: "التقييمات المعلقة",
      noData: "لا توجد بيانات متاحة بعد",
      recentActivity: "النشاط الأخير",
      recentActivityDescription: "ستظهر تحديثات مساحة العمل هنا عند حدوثها.",
      noActivity: "لا يوجد نشاط لعرضه بعد.",
      interviewStatus: "نظرة عامة على حالة المقابلات",
      completed: "مكتملة",
      inProgress: "قيد التنفيذ",
      scheduled: "مجدولة",
      quickAccess: "وصول سريع",
      quickAccessDescription: "انتقل مباشرة إلى المناطق التي تحتاجها أكثر.",
      viewCandidates: "فتح المرشحين",
      viewInterviews: "فتح المقابلات",
      viewEvaluations: "فتح التقييمات",
      viewRecordings: "فتح التسجيلات",
      activeCandidateProfiles: "ملفات المرشحين النشطة",
      upcomingSessions: "جلسات ألمانية قادمة",
      completedRecordings: "التسجيلات والنصوص جاهزة",
      inProgressSessions: "المقابلات النشطة حالياً",
    },
    candidates: {
      title: "المرشحون",
      description: "أضف المعلومات الأساسية اللازمة للتحضير لمقابلة باللغة الألمانية.",
      addCandidate: "إضافة مرشح",
      candidateList: "قائمة المرشحين",
      givenName: "الاسم الأول",
      familyName: "اسم العائلة",
      email: "البريد الإلكتروني",
      create: "إنشاء مرشح",
      creating: "جارٍ إنشاء المرشح…",
      noCandidates: "لم تتم إضافة أي مرشحين بعد.",
      loadFailed: "تعذر تحميل المرشحين.",
      createFailed: "تعذر إكمال إنشاء المرشح.",
      emailExists: "يوجد مرشح بهذا البريد الإلكتروني بالفعل.",
      searchPlaceholder: "ابحث عن المرشحين بالاسم أو البريد الإلكتروني…",
      noSearchResults: "لم يتم العثور على مرشحين مطابقين",
      noSearchResultsDescription: "جرب كلمة بحث أخرى أو امسح التصفية.",
      statusActive: "نشط",
      createdAt: "تاريخ الإضافة",
      actions: "الإجراءات",
      totalCandidatesCount: "{count} مرشحاً",
    },
    interviews: {
      title: "المقابلات",
      description: "أنشئ وراجع جلسات المقابلات المرتبطة بالمرشحين.",
      createSession: "إنشاء جلسة مقابلة",
      candidate: "المرشح",
      selectCandidate: "اختر مرشحاً",
      create: "إنشاء الجلسة",
      creating: "جارٍ إنشاء الجلسة…",
      noCandidates: "أضف مرشحاً قبل إنشاء جلسة مقابلة.",
      noSessions: "لم يتم إنشاء أي جلسات مقابلة بعد.",
      loadFailed: "تعذر تحميل جلسات المقابلات.",
      createFailed: "تعذر إكمال إنشاء جلسة المقابلة.",
      status: "الحالة",
      created: "تاريخ الإنشاء",
      viewDetails: "عرض التفاصيل",
      details: "تفاصيل جلسة المقابلة",
      futureRoom: "غرفة المقابلة",
      futureRoomDescription: "جهز الأجهزة وابدأ المقابلة الذكية المباشرة باللغة الألمانية من هذه الغرفة الآمنة.",
      openRoom: "فتح غرفة المقابلة",
      scheduled: "مجدولة",
      inProgress: "قيد التنفيذ",
      completed: "مكتملة",
      cancelled: "ملغاة",
      failed: "فشلت",
      recording: "تسجيل المقابلة",
      recordingPrivate: "متاح فقط من خلال جلسة Vervio المصرح بها.",
      recordingLoading: "جارٍ تحميل التسجيل…",
      recordingAvailable: "التسجيل الخاص جاهز",
      recordingNotSaved: "لم يتم حفظ تسجيل",
      recordingLoadFailed: "التسجيل غير متاح",
      roomCompletedTitle: "اكتملت المقابلة",
      roomCompletedDescription:
        "انتهت جلسة المقابلة هذه وتم حفظ تسجيلها. لا يمكن إجراء تسجيلات إضافية.",
      requiredLevel: "مستوى اللغة الألمانية المطلوب",
      notConfigured: "غير محدد",
      backToInterviews: "العودة إلى المقابلات",
      searchPlaceholder: "ابحث عن الجلسات باسم المرشح أو حالتها…",
      noMatchingSessions: "لم يتم العثور على جلسات مقابلة مطابقة",
      totalSessions: "{count} جلسات",
    },
    evaluations: {
      title: "التقييمات",
      description: "نتائج تقييم اللغة الألمانية القائمة على الأدلة ومستويات إتقان المرشحين.",
      searchPlaceholder: "تصفية التقييمات حسب اسم المرشح أو البريد الإلكتروني…",
      filterAll: "جميع التقييمات",
      filterCompleted: "المكتملة",
      filterPending: "المعلقة",
      filterInsufficient: "أدلة غير كافية",
      filterFailed: "فشلت",
      totalEvaluated: "إجمالي المقيمين",
      averageScore: "متوسط الدرجات",
      insufficientEvidence: "أدلة غير كافية",
      pendingCount: "قيد التحليل",
      noEvaluations: "لا توجد تقييمات متاحة بعد",
      noEvaluationsDescription: "تتم معالجة مقابلات المرشحين المكتملة وتقييمها تلقائياً لإتقان اللغة الألمانية.",
      noMatchingEvaluations: "لم يتم العثور على تقييمات مطابقة",
      viewFullReport: "عرض التسجيلات والأدلة",
      retryAssessment: "إعادة محاولة التقييم",
    },
    recordingsWorkspace: {
      title: "مساحة التسجيلات",
      description:
        "مجلدات افتراضية للمرشحين تحتوي على جميع المقابلات المسجلة والتقييمات المعتمدة.",
      searchPlaceholder: "ابحث عن مرشح بالاسم أو البريد الإلكتروني…",
      candidateFolders: "مجلدات المرشحين",
      oneRecording: "تسجيل واحد",
      twoRecordings: "تسجيلان",
      multipleRecordings: "{count} تسجيلات",
      noCandidatesWithRecordings: "لا توجد مقابلات مسجلة",
      noCandidatesDescription:
        "ستظهر مجلدات المرشحين هنا بمجرد إجراء المقابلات وحفظ التسجيلات بأمان.",
      noSearchResults: "لم يتم العثور على مجلدات مطابقة",
      noSearchResultsDescription: "جرب البحث باسم مرشح آخر أو عنوان بريد إلكتروني مختلف.",
      backToFolders: "العودة إلى مجلدات المرشحين",
      folderTitle: "تسجيلات مقابلات المرشح",
      folderEmpty: "لا توجد تسجيلات في هذا المجلد",
      folderEmptyDescription:
        "لا يحتوي هذا المرشح على أي تسجيلات مقابلات محفوظة حالياً.",
      loadFailed: "تعذر تحميل دليل التسجيلات.",
      folderLoadFailed: "تعذر تحميل تسجيلات المرشح.",
      retry: "إعادة المحاولة",
      recordedAt: "تاريخ التسجيل",
      interviewStatus: "حالة المقابلة",
      storageStatus: "حالة التخزين",
      evaluationStatus: "حالة التقييم",
      score: "درجة التقييم",
      noScore: "قيد المراجعة",
      pendingEvaluation: "تقييم اللغة قيد الانتظار",
      level: "المستوى الأوروبي (CEFR)",
      summary: "ملخص التقييم",
      watchVideo: "مشاهدة التسجيل",
      hideVideo: "إخفاء الفيديو",
      loadingVideo: "جارٍ تحميل التسجيل الآمن…",
      videoLoadFailed: "تعذر تحميل فيديو التسجيل.",
      duration: "المدة",
      fileSize: "حجم الملف",
      transcriptTitle: "نص المقابلة",
      viewTranscript: "عرض نص المقابلة",
      hideTranscript: "إخفاء نص المقابلة",
      loadingTranscript: "جارٍ تحميل نص المقابلة…",
      transcriptLoadFailed: "تعذر تحميل نص المقابلة.",
      noTranscript: "لا يتوفر نص مقابلة لهذه الجلسة.",
      candidateSpeaker: "المرشح",
      interviewerSpeaker: "المحاور الذكي",
      systemSpeaker: "النظام",
      germanOriginal: "الألمانية الأصلية",
      assessmentTitle: "التقييم اللغوي الذكي للغة الألمانية",
      assessmentSubtitle: "تقييم قائم على الأدلة لأداء المرشح المُثبت في المقابلة باللغة الألمانية",
      assessmentStatus: "حالة التقييم",
      statusPending: "التقييم قيد الانتظار",
      statusAnalyzing: "جارٍ تحليل المقابلة…",
      statusCompleted: "اكتمل التقييم",
      statusInsufficient: "أدلة غير كافية",
      statusFailed: "خطأ في التقييم",
      retryingAssessment: "جارٍ إعادة محاولة التقييم…",
      pendingPollingHint: "يجري إنشاء تقييم المقابلة الألمانية تلقائياً في الخلفية. جارٍ التحقق من النتائج…",
      insufficientEvidenceNotice: "لم توفر هذه المقابلة قدراً كافياً من حديث المرشح بالألمانية لإجراء تقييم لغوي موثوق.",
      failedNotice: "حدث خطأ أثناء تقييم تسجيل المقابلة.",
      failedExplanation: "تعذر إكمال التقييم اللغوي. يمكنك إعادة محاولة التقييم بأمان.",
      assessmentLoadFailed: "تعذر تحميل بيانات التقييم اللغوي.",
      claimedLevel: "المستوى المذكور بالسيرة الذاتية",
      claimedLevelHint: "مُسجل ذاتياً في السيرة الذاتية — لا يؤثر على تقييم الذكاء الاصطناعي",
      notSpecified: "غير محدد",
      assessedLevel: "المستوى الأوروبي المُثبت (CEFR)",
      assessedLevelHint: "تم قياسه بشكل مستقل بواسطة الذكاء الاصطناعي",
      overallScore: "الدرجة الإجمالية للكفاءة",
      requiredLevel: "المستوى الألماني المطلوب",
      notConfigured: "غير محدد",
      updatingRequirement: "جارٍ تحديث المستوى المطلوب…",
      updateRequirementFailed: "تعذر تحديث المستوى الألماني المطلوب.",
      recommendation: "التوصية اللغوية",
      meetsRequirement: "مستوفٍ للمستوى المطلوب",
      belowRequirement: "أقل من المستوى المطلوب",
      insufficientRecommendation: "أدلة غير كافية للتوصية",
      notConfiguredRecommendation: "لم يتم تحديد مستوى مطلوب",
      strengthsTitle: "نقاط القوة اللغوية الرئيسية",
      areasForImprovementTitle: "مجالات التحسين والتطوير",
      criteriaTitle: "تقييم المعايير اللغوية",
      notAssessed: "غير مُقيَّم",
      acousticAnalysisRequired: "يتطلب تحليلاً صوتياً أكوستيكياً — لا يُقيَّم من النص فقط",
      evidenceTitle: "أدلة من نص المقابلة",
      evidenceSubtitle: "اقتباسات ألمانية أصلية وملاحظات لغوية من حديث المرشح",
      turn: "الجولة",
      quote: "الاقتباس",
      observation: "الملاحظة اللغوية",
      hideEvidence: "إخفاء الأدلة",
      showEvidence: "عرض الأدلة ({count})",
    },
    room: {
      title: "غرفة المقابلة",
      loading: "جارٍ تحميل جلسة المقابلة…",
      sessionUnavailable: "جلسة المقابلة هذه غير متاحة.",
      returnToDetails: "العودة إلى تفاصيل المقابلة",
      deviceSetup: "إعداد الأجهزة",
      deviceSetupDescription:
        "اختبر كاميرا وميكروفون المرشح قبل الاتصال بالمقابلة الذكية المباشرة باللغة الألمانية.",
      camera: "الكاميرا",
      microphone: "الميكروفون",
      selectCamera: "اختر الكاميرا",
      selectMicrophone: "اختر الميكروفون",
      noCamera: "لم يتم العثور على كاميرا.",
      noMicrophone: "لم يتم العثور على ميكروفون.",
      enableDevices: "تفعيل الكاميرا والميكروفون",
      retryDevices: "إعادة محاولة إعداد الأجهزة",
      permissionDenied: "تم رفض إذن الكاميرا أو الميكروفون",
      permissionDeniedDescription:
        "اسمح بالوصول إلى الكاميرا والميكروفون في متصفحك، ثم أعد محاولة إعداد الأجهزة.",
      deviceError: "تعذر إكمال إعداد الأجهزة",
      deviceErrorDescription:
        "تحقق من اتصال الكاميرا والميكروفون وتوفرهما وعدم استخدامهما في تطبيق آخر.",
      candidatePreview: "معاينة كاميرا المرشح",
      cameraOff: "معاينة الكاميرا متوقفة",
      aiInterviewer: "المحاور الذكي",
      aiInterviewerDescription:
        "يجري المحاور الذكي المحادثة المباشرة باللغة الألمانية، بشكل مستقل عن لغة واجهة التطبيق.",
      microphoneActivity: "نشاط الميكروفون",
      cameraStatus: "حالة الكاميرا",
      microphoneStatus: "حالة الميكروفون",
      on: "قيد التشغيل",
      off: "متوقف",
      connection: "اتصال الذكاء الاصطناعي",
      notConnected: "غير متصل",
      connectionIdle: "جاهز للاتصال",
      connectionConnecting: "جارٍ الاتصال بشكل آمن…",
      connectionConnected: "متصل — المقابلة الصوتية بالألمانية مباشرة",
      connectionEnding: "جارٍ إنهاء المقابلة…",
      connectionEnded: "انتهت المقابلة",
      connectionFailed: "فشل الاتصال",
      connectionError: "خطأ في اتصال الصوت الذكي",
      microphoneUnavailable: "فعّل ميكروفوناً يعمل قبل بدء المقابلة.",
      secureSessionUnavailable: "الجلسة الآمنة غير متاحة. يُرجى تسجيل الدخول مرة أخرى.",
      connectionNotAuthorized: "لست مخولاً لبدء هذه المقابلة.",
      serviceNotConfigured: "خدمة الصوت الذكي غير مهيأة بعد. أضف إعداد Gemini من جانب الخادم ثم حاول مرة أخرى.",
      connectionFailedMessage: "تعذر بدء اتصال الصوت الذكي. يُرجى المحاولة مرة أخرى.",
      connectionTimedOut: "انتهت مهلة اتصال الصوت الذكي. يُرجى المحاولة مرة أخرى.",
      connectionInterrupted: "تمت مقاطعة اتصال الصوت الذكي.",
      audioPlaybackFailed: "تعذر على المتصفح تشغيل صوت الذكاء الاصطناعي. تحقق من أذونات الصوت وجهاز الإخراج.",
      aiSpeaking: "المحاور الذكي يتحدث",
      aiListening: "المحاور الذكي يستمع",
      candidateSpeaking: "المرشح يتحدث",
      candidateListening: "ميكروفون المرشح جاهز",
      deviceTestTimer: "اختبار الأجهزة قبل المقابلة",
      interviewTimer: "مدة المقابلة النشطة",
      startInterview: "بدء المقابلة",
      startInterviewDescription:
        "يبدأ التسجيل الخاص ويربط الميكروفون المحدد بمقابلة مباشرة مع الذكاء الاصطناعي باللغة الألمانية. تنتهي الجلسات التجريبية تلقائياً بعد دقيقتين. لا يُرسل فيديو الكاميرا إلى الذكاء الاصطناعي.",
      endInterview: "إنهاء المقابلة",
      recording: "التسجيل",
      recordingReady: "يبدأ مع المقابلة",
      recordingInProgress: "يجري تسجيل الصوتين",
      recordingUploading: "جارٍ الحفظ بأمان…",
      recordingSaved: "حُفظ بشكل خاص",
      recordingFailed: "فشل التسجيل",
      recordingError: "خطأ في تسجيل المقابلة",
      recordingStartFailed: "تعذر على المتصفح بدء تسجيل آمن للمقابلة.",
      recordingUploadFailed: "تعذر حفظ التسجيل بأمان. لم يتم اعتبار المقابلة مكتملة.",
      instructionsTitle: "قبل البدء",
      instructions:
        "تحقق من الإطار وإدخال الصوت واختيار الأجهزة. ابدأ فقط عندما يكون المرشح مستعداً لمحادثة مباشرة باللغة الألمانية. يبدأ التسجيل فقط مع المقابلة المباشرة. لا ينسخ هذا الإصدار المقابلة أو يقيمها.",
      alreadyCompletedTitle: "المقابلة مكتملة بالفعل",
      alreadyCompletedDescription:
        "تم إجراء هذه المقابلة وتسجيلها بالفعل. تسمح كل جلسة مقابلة بتسجيل واحد فقط.",
      alreadyRecordedError:
        "جلسة المقابلة هذه تحتوي بالفعل على تسجيل محفوظ ولا يمكن إعادة تسجيلها.",
      maxDurationNotice: "دقيقتان كحد أقصى",
      guidelines: "الإرشادات",
      guidelinesAcknowledge: "أفهم ذلك — متابعة",
      guidelineGermanOnly: "تحدث بالألمانية فقط طوال المقابلة.",
      guidelineTimeLimit: "تستغرق المقابلة المباشرة حتى 120 ثانية.",
      guidelineDevices: "أبقِ الكاميرا والميكروفون متاحين طوال المقابلة.",
      guidelineIndependent: "أجب بصورة مستقلة وبكلماتك الخاصة.",
      guidelinesRequired: "راجع إرشادات المقابلة وأقرّ بها قبل البدء.",
      devicesPreparing: "جارٍ تجهيز الكاميرا والميكروفون…",
      cameraReady: "الكاميرا جاهزة",
      microphoneReady: "الميكروفون جاهز",
      deviceLostDuringInterview:
        "أصبحت الكاميرا أو الميكروفون المطلوب غير متاح. يجري إنهاء المقابلة وحفظ التسجيل إن أمكن.",
      retryRecordingUpload: "إعادة محاولة الرفع الآمن",
      interviewEnding: "جارٍ إنهاء المقابلة وحفظها…",
    },
    emptyStates: {
      evaluations: {
        title: "لا توجد تقييمات لعرضها",
        description: "ستظهر تقارير التقييم هنا عندما تصبح متاحة للمراجعة.",
      },
      settings: {
        title: "الإعدادات غير متاحة بعد",
        description: "ستتم إضافة إعدادات إدارة مساحة العمل في مرحلة لاحقة.",
      },
    },
    authorization: {
      checking: "جارٍ التحقق من صلاحية الإدارة…",
      unavailable: "صلاحية الإدارة غير متاحة حالياً.",
    },
    accessDenied: {
      title: "تم رفض الوصول",
      description: "حسابك غير مصرّح له بالوصول إلى هذه المنطقة. تواصل مع Vervio إذا كانت لديك أسئلة.",
      returnToDashboard: "العودة إلى لوحة التحكم",
    },
    roles: {
      admin: "المسؤول",
      clientReviewer: "مراجع العميل",
    },
  },
};

type LocaleContextValue = {
  locale: Locale;
  direction: "ltr" | "rtl";
  setLocale: (locale: Locale) => void;
  t: Translation;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);
const LOCALE_STORAGE_KEY = "vervio_locale";

function isLocale(value: string | null): value is Locale {
  return value !== null && locales.includes(value as Locale);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const [hasLoadedPreference, setHasLoadedPreference] = useState(false);

  useEffect(() => {
    const savedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(savedLocale)) {
      setLocale(savedLocale);
    }
    setHasLoadedPreference(true);
  }, []);

  useEffect(() => {
    const direction = locale === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;

    if (hasLoadedPreference) {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    }
  }, [hasLoadedPreference, locale]);

  const value = useMemo(
    () => ({
      locale,
      direction: locale === "ar" ? ("rtl" as const) : ("ltr" as const),
      setLocale,
      t: translations[locale],
    }),
    [locale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used inside LocaleProvider.");
  }
  return context;
}

export function formatTranslation(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}
