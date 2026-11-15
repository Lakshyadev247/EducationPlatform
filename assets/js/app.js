/* ==========================================================================
   Education Platform - Auth behaviour (Part 1 login + Part 2 teacher signup)
   Vanilla JS. Authentication, data and uploads go through the same-origin
   Laravel API; no credential or token is written to browser storage.

   Views (one visible at a time):
     #view-login         -> login
     #view-account-type  -> choose Teacher / Student
     #view-teacher-signup-> teacher registration
   ========================================================================== */
(function () {
  "use strict";

  // Registered first so any later failure is visible rather than leaving a
  // dead button with no explanation.
  function reportError(message) {
    const bar = document.getElementById("errbar");
    const msg = document.getElementById("errbar-msg");
    if (!bar || !msg) return;
    msg.textContent = "Application script error: " + message;
    bar.hidden = false;
  }
  window.addEventListener("error", function (event) {
    reportError(event.message || "unknown error");
  });
  window.addEventListener("unhandledrejection", function (event) {
    reportError((event.reason && event.reason.message) || "unknown error");
  });

  
  // The application is served by Laravel, so every call below is same-origin.
  // Authentication uses the Laravel session (Sanctum stateful mode) plus the
  // CSRF token issued by /api/v1/auth/csrf. No token is written to storage.
  const API_ROOT = "/api/v1";
  let csrfToken = "";
  let sessionUser = null;
  let sessionProfile = null;
  // The signed-in teacher's own listing state, read from the server profile.
  let teacherListing = { approvalStatus: "", isPublic: false };
  let sessionReady = false;
  // True while the sign-in request and the data it triggers are running. A
  // request that was already on its way when the sign-in regenerated the
  // session is answered with 401, and that is not a lost session.
  let loginSubmitting = false;
  let studentLoginSubmitting = false;
  // The first render happens before /me has answered. A protected deep link
  // must not be rewritten to the login URL at that point, or restoring the
  // session would land on the login screen instead of the requested screen.
  let authChecked = false;
  let apiMeta = null;
  // True once /meta has answered, so the app knows whether the published
  // terms are really missing or simply not loaded yet.
  let metaLoaded = false;
  let apiTeachers = [];
  let apiAdminBookings = [];
  let apiAdminUsers = [];
  let apiAdminTeachers = [];
  let apiAdminHolidays = [];
  let apiAdminTerms = [];
  let apiAdminRoles = [];
  let apiWhatsappStatus = null;
  let adminAuditLoaded = false;
  let availableAuditActions = [];
  let adminAuditSearchTimer = null;
  let customTermsPolicies = [];
  try {
    const savedCustomPolicies = localStorage.getItem("app_custom_policies");
    if (savedCustomPolicies) customTermsPolicies = JSON.parse(savedCustomPolicies);
  } catch (e) {}
  // Guards against a second sign-out request while the first one is still in
  // flight, so one click can never end two sessions.
  let logoutInFlight = false;

  function apiUrl(path) {
    return API_ROOT + path;
  }

  function apiErrorMessage(error) {
    if (!error) return "The request could not be completed.";
    if (error.errors) {
      const first = Object.keys(error.errors)[0];
      if (first && error.errors[first] && error.errors[first].length) {
        return String(error.errors[first][0]);
      }
    }
    return error.message || "The request could not be completed.";
  }

  function apiFieldErrors(error) {
    return (error && error.errors) ? error.errors : {};
  }

  async function ensureCsrf(force) {
    if (csrfToken && !force) return csrfToken;
    const response = await fetch(apiUrl("/auth/csrf"), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Could not start a secure session.");
    const payload = await response.json();
    csrfToken = payload.token || "";
    return csrfToken;
  }

  async function apiRequest(path, options) {
    const opts = options || {};
    const method = String(opts.method || "GET").toUpperCase();
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    let body = opts.body;

    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }

    if (method !== "GET" && method !== "HEAD") {
      headers["X-CSRF-TOKEN"] = await ensureCsrf(false);
    }

    let response = await fetch(apiUrl(path), {
      method: method,
      credentials: "same-origin",
      headers: headers,
      body: body,
    });

    if (response.status === 419 && !opts.retried) {
      csrfToken = "";
      await ensureCsrf(true);
      return apiRequest(path, Object.assign({}, opts, { retried: true }));
    }

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = { message: text.slice(0, 300) };
      }
    }

    if (!response.ok) {
      const error = new Error(payload.message || "Request failed (" + response.status + ").");
      error.status = response.status;
      error.errors = payload.errors || {};
      error.payload = payload;
      if (
        response.status === 401 &&
        sessionUser &&
        !loginSubmitting &&
        !studentLoginSubmitting &&
        !isSignOutCall(path)
      ) {
        // The server no longer accepts this session. The app must not keep
        // showing an empty panel as if it were signed in.
        handleUnconfirmedSession();
      }
      throw error;
    }

    return payload;
  }

  // The sign-out call reads the 401 itself, because a 401 there means the
  // session is already gone. The shared handler must not step in for it.
  function isSignOutCall(path) {
    return String(path || "").indexOf("/auth/logout") !== -1;
  }

  // A request the server answers with 401 while the app believes it is signed
  // in means the session is gone: the cookie was not accepted, it expired, or
  // it was signed out somewhere else. The local state is dropped and the
  // sign-in screen is shown with the reason, instead of leaving an empty
  // panel behind.
  function handleUnconfirmedSession() {
    if (!sessionUser) return;
    clearSessionState();
    showToast("Your session could not be confirmed. Please sign in again.");
    navigate("login");
  }

  async function downloadApiFile(path, fallbackName) {
    const response = await fetch(apiUrl(path), {
      credentials: "same-origin",
      headers: { Accept: "text/csv,application/octet-stream" },
    });
    if (!response.ok) {
      let message = "The export could not be downloaded.";
      try {
        const payload = await response.json();
        message = payload.message || message;
      } catch (err) { /* not JSON */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    downloadBlob(blob, match ? match[1] : fallbackName);
    return true;
  }

  function rolesOf(user) {
    return (user && user.roles ? user.roles : []).map(function (role) {
      return role.name;
    });
  }

  function hasRoleName(user, name) {
    return rolesOf(user).indexOf(name) !== -1;
  }

  function isAdminSession() {
    return hasRoleName(sessionUser, "admin") || hasRoleName(sessionUser, "super_admin");
  }

  function isSuperAdminSession() {
    return hasRoleName(sessionUser, "super_admin");
  }

  function primaryRole() {
    if (isSuperAdminSession()) return "super_admin";
    if (isAdminSession()) return "admin";
    if (hasRoleName(sessionUser, "teacher")) return "teacher";
    if (hasRoleName(sessionUser, "student")) return "student";
    return "";
  }

  function homeRouteForRole() {
    const role = primaryRole();
    if (role === "student") return "studentDashboard";
    if (role === "teacher") return "dashboard";
    if (role === "admin" || role === "super_admin") return "admin";
    return "login";
  }

  function mapTeacher(teacher) {
    const location = teacher.location || {};
    const subjectLabels = (teacher.subjects || []).map(function (subject) {
      return subject.name;
    });
    const gradeLabels = (teacher.grades || []).map(function (grade) {
      return grade.label || grade.key;
    });
    const streamLabels = (teacher.streams || []).map(function (stream) {
      return stream.label || stream.key;
    });
    const availabilityByDay = {};
    (teacher.availability || []).forEach(function (slot) {
      const key = slot.day;
      if (!availabilityByDay[key]) {
        availabilityByDay[key] = { id: key, label: "", slots: [] };
      }
      availabilityByDay[key].slots.push({
        start: String(slot.start_time || "").slice(0, 5),
        end: String(slot.end_time || "").slice(0, 5),
      });
    });
    const availability = Object.keys(availabilityByDay).map(function (key) {
      const day = DAY_LOOKUP[key] || { label: key };
      availabilityByDay[key].label = day.label;
      return availabilityByDay[key];
    });
    const modeKey = teacher.teaching_mode || "";
    const country = location.country || "";
    return {
      id: String(teacher.id),
      name: teacher.name,
      email: "",
      bio: teacher.bio || "",
      photoUrl: teacher.photo_url || null,
      subjects: subjectLabels,
      grades: gradeLabels,
      gradeKeys: (teacher.grades || []).map(function (grade) { return grade.key; }),
      streams: streamLabels,
      streamKeys: (teacher.streams || []).map(function (stream) { return stream.key; }),
      otherLevel: teacher.level_other || "",
      modeKey: modeKey,
      mode: MODE_LABELS[modeKey] || "",
      radius: location.radius_km ? "Within " + location.radius_km + " km" : "",
      area: location.area || "",
      city: location.city || "",
      state: location.state || "",
      country: country,
      location: [location.area, location.city, location.state, location.country].filter(Boolean).join(", "),
      availability: availability,
      availableDays: availability.map(function (entry) { return entry.label; }),
      qualifications: (teacher.qualifications || []).map(function (qualification) {
        return {
          name: qualification.name || "",
          institution: qualification.institution || "",
          year: qualification.year === null || qualification.year === undefined ? "" : String(qualification.year),
        };
      }),
      experienceLevel: teacher.experience_level
        ? ((LEVEL_RANGES[teacher.experience_level] || {}).label || teacher.experience_level)
        : "",
      experienceYears: teacher.experience_years === null || teacher.experience_years === undefined
        ? "" : String(teacher.experience_years),
      prices: teacher.prices || {},
      ratingAverage: Number(teacher.rating_average || 0),
      reviewCount: Number(teacher.review_count || 0),
      approvalStatus: teacher.approval_status || null,
      isPublic: teacher.is_public,
      documentsVerified: !!teacher.documents_verified,
      documentVerificationStatus: teacher.document_verification_status || "not_uploaded",
      documentVerifiedAt: teacher.document_verified_at,
      documentRejectionReason: teacher.document_rejection_reason,
      idDocument: teacher.id_document,
      qualificationDocument: teacher.qualification_document,
      completed: !!teacher.completed,
      raw: teacher,
    };
  }

  function mapBooking(booking) {
    const mode = booking.teaching_mode || "";
    return {
      id: String(booking.id),
      reference: booking.reference || "",
      studentId: String(booking.student_id),
      studentName: booking.student_name || "Student",
      teacherId: String(booking.teacher_id),
      teacherName: booking.teacher_name || "Teacher",
      subject: booking.subject || "",
      date: booking.date || "",
      time: String(booking.start_time || "").slice(0, 5),
      endTime: booking.end_time || "",
      durationMinutes: booking.duration_minutes || 60,
      mode: mode,
      modeLabel: MODE_LABELS[mode] || mode,
      bookingType: booking.booking_type || "demo",
      agreedPrice: booking.agreed_price !== null && booking.agreed_price !== undefined ? Number(booking.agreed_price) : null,
      pricingType: booking.pricing_type || "",
      adminNotes: booking.admin_notes || "",
      studentPhone: booking.student_phone || "",
      studentEmail: booking.student_email || "",
      teacherPhone: booking.teacher_phone || "",
      teacherEmail: booking.teacher_email || "",
      message: booking.message || "",
      rejectionReason: booking.rejection_reason || "",
      status: booking.status === "completed" ? "accepted" : booking.status,
      rawStatus: booking.status,
      // A completed lesson is still shown as "accepted" in the flow logic, but
      // the label and the review action must be able to tell the truth.
      completed: booking.status === "completed",
      createdAt: booking.created_at || "",
      decidedAt: booking.decided_at || "",
      cancelledAt: booking.cancelled_at || "",
      completedAt: booking.completed_at || "",
      attendance: booking.attendance || null,
      review: booking.review || null,
    };
  }

  function mapAttendance(record) {
    const mode = record.teaching_mode || "";
    return {
      id: String(record.id),
      bookingId: String(record.booking_id),
      bookingReference: record.booking_reference || "",
      teacherId: String(record.teacher_id),
      teacherName: record.teacher_name || "Teacher",
      studentId: String(record.student_id),
      studentName: record.student_name || "Student",
      subject: record.subject || "",
      date: record.date || "",
      time: String(record.start_time || "").slice(0, 5),
      mode: mode,
      modeLabel: MODE_LABELS[mode] || mode,
      result: record.result,
      currentResult: record.current_result || record.result,
      absenceReason: record.absence_reason || "",
      confirmation: record.confirmation,
      studentResponse: record.student_response || "",
      markedAt: record.marked_at || "",
      respondedAt: record.responded_at || "",
      resolvedAt: record.resolved_at || "",
      corrections: record.corrections || [],
      decisions: record.decisions || [],
    };
  }

  function mapReview(review) {
    return {
      id: String(review.id),
      studentId: review.student_id ? String(review.student_id) : null,
      studentName: review.student_name || "Student",
      teacherId: String(review.teacher_id),
      teacherName: review.teacher_name || "Teacher",
      bookingId: review.booking_id ? String(review.booking_id) : "",
      rating: Number(review.rating || 0),
      text: review.text || "",
      status: review.status || "published",
      moderationNote: review.moderation_note || "",
      createdAt: review.published_at || review.created_at || "",
      publishedAt: review.published_at || "",
    };
  }

  function mapNotification(notification) {
    return {
      id: notification.id,
      // The API only ever returns the signed-in user's notifications, so the
      // owner is the session user. It is stored as a string because the
      // current student and teacher ids are strings too, and a strict
      // comparison against a number silently hid every notification.
      recipientId: sessionUser ? String(sessionUser.id) : "",
      recipientRole: primaryRole() || "user",
      title: notification.title || "Notification",
      message: notification.message || "",
      category: notification.category || "system",
      read: !!notification.read,
      createdAt: notification.created_at || new Date().toISOString(),
      readAt: notification.read_at || "",
      refType: notification.ref_type || "",
      refId: notification.ref_id || "",
      // Was hardcoded to "". The reminder due-count keys off this, so with an
      // empty value every pending record looked un-reminded and the count was
      // wrong. The server returns the real token.
      dedupeKey: notification.dedupe_key || "",
    };
  }

  function replaceArray(target, values) {
    target.length = 0;
    Array.prototype.push.apply(target, values);
  }

  function applyMeta(meta) {
    apiMeta = meta || null;
    if (!meta || !meta.settings) return;
    const settings = meta.settings;
    if (settings.general) Object.assign(platformSettings.general, settings.general);
    if (settings.branding) Object.assign(platformSettings.branding, settings.branding);
    if (settings.contact) Object.assign(platformSettings.contact, settings.contact);
    if (settings.whatsapp) Object.assign(platformSettings.whatsapp, settings.whatsapp);
    if (settings.otp) Object.assign(platformSettings.otp, settings.otp);
    if (settings.pricing) {
      Object.keys(settings.pricing).forEach(function (key) {
        if (platformSettings.pricing[key]) Object.assign(platformSettings.pricing[key], settings.pricing[key]);
      });
    }
    if (settings.eligibility) {
      Object.assign(platformSettings.eligibility, settings.eligibility);
      reviewPolicy.configured = !!settings.eligibility.configured;
      reviewPolicy.type = settings.eligibility.type || "study-days";
      reviewPolicy.minConfirmedDays = Number(settings.eligibility.minConfirmedDays || 0);
      reviewPolicy.minCompletedLessons = Number(settings.eligibility.minCompletedLessons || 0);
      reviewPolicy.requireCompletedBooking = settings.eligibility.requireCompletedBooking !== false;
    }
    if (typeof updateTeacherOtpVisibility === "function") updateTeacherOtpVisibility();
    if (typeof updateStudentOtpVisibility === "function") updateStudentOtpVisibility();
    if (typeof updateForgotPasswordUI === "function") updateForgotPasswordUI();
    if (Array.isArray(meta.terms)) {
      meta.terms.forEach(function (doc) {
        platformSettings.terms[doc.audience] = {
          role: doc.audience,
          version: doc.version,
          title: doc.title,
          body: doc.body,
          effectiveDate: doc.effective_date || "",
          publishedAt: doc.published_at || "",
          publishedBy: "Administrator",
          history: (platformSettings.terms[doc.audience] || {}).history || [],
        };
      });
    }
    applyBranding();
    renderContactSections();
    renderTermsLinks();
    if (typeof updateTeacherOtpVisibility === "function") updateTeacherOtpVisibility();
    if (typeof updateStudentOtpVisibility === "function") updateStudentOtpVisibility();
    if (typeof updateForgotPasswordUI === "function") updateForgotPasswordUI();
    metaLoaded = true;
  }

  async function loadMeta() {
    try {
      const response = await apiRequest("/meta");
      applyMeta(response.data || {});
    } catch (error) {
      console.warn("Metadata unavailable:", apiErrorMessage(error));
    }
  }

  function applyStudentProfile(profile) {
    if (!profile) return;
    studentState.id = profile.id;
    studentState.signup = {
      fullName: profile.name || "",
      email: profile.email || "",
      level: profile.level || "",
      levelOther: profile.level_other || "",
    };
    studentState.profile = {
      fullName: profile.name || "",
      email: profile.email || "",
      level: profile.level || "",
      levelOther: profile.level_other || "",
      intro: profile.intro || "",
      photoUrl: profile.photo_url || null,
    };
    studentState.hasProfile = !!(profile.level || profile.intro || profile.completed);
    studentState.completed = !!profile.completed;
    sProfileName.value = studentState.profile.fullName;
    sProfileEmail.value = studentState.profile.email;
    sProfileGrade.value = studentState.profile.level || "";
    sProfileGradeOther.value = studentState.profile.levelOther;
    syncStudentOtherField(sProfileGrade, sProfileGradeOtherField);
    sProfileIntro.value = studentState.profile.intro;
    sIntroCount.textContent = String(sProfileIntro.value.length);
    renderStudentPhoto(profile.photo_url || null);
  }

  function applyTeacherProfile(profile) {
    if (!profile) return;
    teacherListing.approvalStatus = profile.approval_status || "";
    teacherListing.isPublic = !!profile.is_public;
    teacherListing.documentsVerified = !!profile.documents_verified;
    teacherListing.documentVerificationStatus = profile.document_verification_status || "not_uploaded";
    teacherListing.documentVerifiedAt = profile.document_verified_at;
    teacherListing.documentRejectionReason = profile.document_rejection_reason;
    teacherListing.idDocument = profile.id_document;
    teacherListing.qualificationDocument = profile.qualification_document;
    teacherListing.diagnostic = profile.listing_diagnostic || null;
    pName.value = profile.name || (sessionUser ? sessionUser.name : "");
    pEmail.value = profile.email || (sessionUser ? sessionUser.email : "");
    pBio.value = profile.bio || "";
    bioCount.textContent = pBio.value.length + " / " + 300;
    applyPhotoUrl(profile.photo_url || null);

    expLevel.value = profile.experience_level || "";
    expYears.value = profile.experience_years === null || profile.experience_years === undefined
      ? "" : String(profile.experience_years);
    expOrg.value = profile.experience_org || "";
    expDesc.value = profile.experience_description || "";
    expDescCount.textContent = String(expDesc.value.length);

    qualList.innerHTML = "";
    (profile.qualifications || []).forEach(function (qualification) {
      addQualificationRow(qualification);
    });
    if (!qualList.children.length) addQualificationRow();
    renumberQualifications();

    subjectGrid.querySelectorAll("[data-subject]").forEach(function (input) {
      input.checked = false;
    });
    customSubjects = [];
    (profile.subjects || []).forEach(function (subject) {
      const common = COMMON_SUBJECTS.filter(function (item) {
        return item.label.toLowerCase() === String(subject.name || "").toLowerCase();
      })[0];
      if (common) {
        const input = subjectGrid.querySelector('[data-subject="' + common.id + '"]');
        if (input) input.checked = true;
      } else if (subject.name) {
        customSubjects.push({
          key: String(subject.slug || subject.name).toLowerCase(),
          label: subject.name,
          common: false,
        });
      }
    });
    renderSubjectChips();

    const gradeKeys = (profile.grades || []).map(function (grade) { return grade.key; });
    gradeGrid.querySelectorAll("[data-grade]").forEach(function (input) {
      input.checked = gradeKeys.indexOf(input.getAttribute("data-grade")) !== -1;
    });
    const streamKeys = (profile.streams || []).map(function (stream) { return stream.key; });
    streamGrid.querySelectorAll("[data-stream]").forEach(function (input) {
      input.checked = streamKeys.indexOf(input.getAttribute("data-stream")) !== -1;
    });
    otherLevel.value = profile.level_other || "";
    syncCheckStates();
    toggleConditionalFields();

    modeList.querySelectorAll("[data-mode]").forEach(function (input) {
      input.checked = input.value === (profile.teaching_mode || "");
    });
    syncModeCards();
    locOnlineTools.value = profile.online_tools || "";
    onlineToolsCount.textContent = String(locOnlineTools.value.length);

    const location = profile.location || {};
    const countryItem = COUNTRIES.filter(function (country) {
      return country.label.toLowerCase() === String(location.country || "").toLowerCase()
        || country.value === String(location.country || "").toLowerCase();
    })[0];
    locCountry.value = countryItem ? countryItem.value : "other";
    populateStates();
    if (!locStateTextControl.hidden) {
      locStateText.value = location.state || "";
    } else {
      if (location.state && !Array.prototype.some.call(locState.options, function (option) {
        return option.value === location.state;
      })) {
        const option = document.createElement("option");
        option.value = location.state;
        option.textContent = location.state;
        locState.appendChild(option);
      }
      locState.value = location.state || "";
    }
    locCity.value = location.city || "";
    locArea.value = location.area || "";
    const radiusKm = Number(location.radius_km || 0);
    locRadius.value = radiusKm ? "Within " + radiusKm + " km" : "No limit";
    updateConditionalFields();

    DAYS.forEach(function (day) {
      availableDayIds.delete(day.id);
      availabilitySlots[day.id] = [];
    });
    (profile.availability || []).forEach(function (slot) {
      const key = slot.day || ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][slot.day_of_week];
      if (!key) return;
      availableDayIds.add(key);
      availabilitySlots[key].push({
        start: String(slot.start_time || "").slice(0, 5),
        end: String(slot.end_time || "").slice(0, 5),
      });
    });
    // The day checkboxes are the teacher's view of the saved schedule, so they
    // have to show the days that were loaded. syncCheckStates() only reads the
    // checkbox, it never writes it.
    dayGrid.querySelectorAll("[data-day]").forEach(function (input) {
      input.checked = availableDayIds.has(input.getAttribute("data-day"));
    });
    renderAvailabilityDays();
    syncCheckStates();

    teacherPrices[profile.id] = {
      hourly: profile.prices && profile.prices.hourly ? profile.prices.hourly.amount : null,
      monthly: profile.prices && profile.prices.monthly ? profile.prices.monthly.amount : null,
      course: profile.prices && profile.prices.course ? profile.prices.course.amount : null,
    };
    teacherPrices["session-teacher"] = teacherPrices[profile.id];

    if (!pName.value && sessionUser) pName.value = sessionUser.name || "";
    if (!pEmail.value && sessionUser) pEmail.value = sessionUser.email || "";
    sessionProfile = profile;
  }

  function applySessionResponse(payload) {
    sessionUser = payload && payload.data ? payload.data : null;
    sessionProfile = payload && payload.profile ? payload.profile : null;
    if (!sessionUser) return;
    if (sessionProfile && hasRoleName(sessionUser, "student")) {
      applyStudentProfile(sessionProfile);
    } else if (sessionProfile && hasRoleName(sessionUser, "teacher")) {
      applyTeacherProfile(sessionProfile);
      loadTeacherDocuments().catch(function () {});
    }
    if (isAdminSession()) {
      adminSession.role = isSuperAdminSession() ? "super-admin" : "admin";
    }
  }

  async function refreshSession() {
    const payload = await apiRequest("/me");
    applySessionResponse(payload);
    sessionReady = true;
    return payload;
  }

  async function loadPublicTeachers() {
    const payload = await apiRequest("/teachers?per_page=24");
    apiTeachers = (payload.data || []).map(mapTeacher);
    return apiTeachers;
  }

  async function loadBookings() {
    const payload = await apiRequest("/bookings?per_page=100");
    replaceArray(bookings, (payload.data || []).map(mapBooking));
    return bookings;
  }

  async function loadAttendance() {
    const payload = await apiRequest("/attendance");
    const records = (payload.data || []).map(mapAttendance);
    replaceArray(attendance, records);
    replaceArray(corrections, []);
    replaceArray(decisions, []);
    records.forEach(function (record) {
      (record.corrections || []).forEach(function (correction) {
        corrections.push({
          id: correction.id,
          attendanceId: String(correction.attendance_id),
          requesterId: correction.requester_id,
          requesterRole: correction.requester_role,
          explanation: correction.explanation || "",
          status: correction.status,
          createdAt: correction.created_at || "",
          resolvedAt: correction.resolved_at || "",
        });
      });
      (record.decisions || []).forEach(function (decision) {
        decisions.push({
          id: decision.id,
          attendanceId: String(decision.attendance_id),
          bookingId: record.bookingId,
          correctionId: decision.correction_id ? String(decision.correction_id) : "",
          reviewerId: decision.reviewer_id,
          originalResult: decision.original_result,
          finalResult: decision.final_result,
          decisionType: decision.decision_type,
          decisionLabel: DECISION_LABELS[decision.decision_type] || decision.decision_type,
          reason: decision.reason || "",
          decidedAt: decision.decided_at || "",
        });
      });
    });
    return records;
  }

  async function loadReviews() {
    if (isAdminSession()) return reviews;
    const payload = await apiRequest("/reviews?per_page=100");
    replaceArray(reviews, (payload.data || []).map(mapReview));
    return reviews;
  }

  async function loadNotifications() {
    const payload = await apiRequest("/notifications?per_page=100");
    replaceArray(notifications, (payload.data || []).map(mapNotification));
    updateNotificationBadges();
    return notifications;
  }

  async function loadTeacherReviews(teacherId) {
    try {
      const payload = await apiRequest("/teachers/" + encodeURIComponent(teacherId) + "/reviews?per_page=50");
      const loaded = (payload.data || []).map(mapReview);
      const existing = {};
      reviews.forEach(function (review) { existing[review.id] = true; });
      loaded.forEach(function (review) {
        if (!existing[review.id]) reviews.push(review);
      });
    } catch (error) {
      console.warn("Teacher reviews unavailable:", apiErrorMessage(error));
    }
  }

  function mapAdminUser(user) {
    return {
      id: String(user.id),
      name: user.name || "Account",
      email: user.email || "",
      phone: user.phone || "",
      status: user.status || "active",
      roles: rolesOf(user),
      role: (rolesOf(user)[0] || "student"),
      createdAt: user.created_at || "",
      lastLoginAt: user.last_login_at || "",
      level: user.level_label || user.level || (user.student_profile && (user.student_profile.level_label || user.student_profile.level)) || "",
      approved: !(user.teacher_profile && user.teacher_profile.approval_status === "pending"),
    };
  }

  async function loadAdminState() {
    const calls = await Promise.allSettled([
      apiRequest("/admin/users?per_page=100"),
      apiRequest("/admin/directory/users?per_page=100"),
      apiRequest("/admin/teachers?per_page=100"),
      apiRequest("/admin/attendance?filter=all&per_page=100"),
      apiRequest("/admin/reviews?per_page=100"),
      apiRequest("/admin/audit-logs?per_page=20"),
      apiRequest("/admin/holidays"),
      apiRequest("/admin/terms"),
      apiRequest("/admin/settings"),
      apiRequest("/admin/roles"),
      apiRequest("/admin/whatsapp/status"),
      // NOTE: an "/admin/dashboard" call used to sit here. No such route exists
      // and its payload was never read (valueAt() is only used for indices 0-8),
      // so it was a wasted request on every admin load. Admin overview figures
      // are derived client-side from the lists loaded above.
      // The bookings list is read by its own index, so it never shifts the
      // indices above it.
      apiRequest("/admin/bookings?per_page=10"),
      // The data panel is Super Admin only. Asking as a regular admin would
      // only produce a 403 on every load, so it is skipped for them.
      isSuperAdminSession() ? apiRequest("/admin/data") : Promise.resolve(null),
      isSuperAdminSession() ? apiRequest("/admin/storage/dashboard") : Promise.resolve(null),
      isSuperAdminSession() ? apiRequest("/admin/storage/providers") : Promise.resolve(null),
    ]);

    function valueAt(index) {
      return calls[index].status === "fulfilled" ? calls[index].value : null;
    }

    const usersPayload = valueAt(1) || valueAt(0);
    if (usersPayload) {
      apiAdminUsers = (usersPayload.data || []).map(mapAdminUser);
    }

    const teachersPayload = valueAt(2);
    if (teachersPayload) {
      apiAdminTeachers = (teachersPayload.data || []).map(function (teacher) {
        const mapped = mapTeacher(teacher);
        mapped.approved = teacher.approval_status === "approved" || !!teacher.is_public;
        mapped.approvalStatus = teacher.approval_status || "";
        mapped.isPublic = !!teacher.is_public;
        const account = apiAdminUsers.filter(function (user) { return user.id === teacher.id; })[0];
        if (account) {
          mapped.name = account.name || mapped.name;
          mapped.email = account.email || mapped.email;
          mapped.status = account.status;
        }
        return mapped;
      });
    }

    // The bookings the administrator can see. A booking belongs to the student
    // and the teacher; the administrator may cancel one, which is why they
    // have to be able to find it.
    const bookingsPayload = valueAt(11);
    if (bookingsPayload) {
      apiAdminBookings = (bookingsPayload.data || []).map(mapAdminBooking);
      const bookingsMeta = bookingsPayload.meta || {};
      adminBookingsPage = Math.max(1, Number(bookingsMeta.current_page || 1));
      adminBookingsPages = Math.max(1, Number(bookingsMeta.last_page || 1));
      adminBookingsTotal = Number(bookingsMeta.total || apiAdminBookings.length);
    }

    const dataPayload = valueAt(12);
    if (dataPayload && dataPayload.data) {
      adminDataOverview = dataPayload.data;
      adminDataResult = null;
    }

    const storageDashPayload = valueAt(13);
    if (storageDashPayload && storageDashPayload.data) {
      adminStorageDashboard = storageDashPayload.data;
    }
    const storageProvidersPayload = valueAt(14);
    if (storageProvidersPayload && storageProvidersPayload.data) {
      adminStorageProviders = storageProvidersPayload.data;
    }

    const attendancePayload = valueAt(3);    if (attendancePayload) {
      const records = (attendancePayload.data || []).map(mapAttendance);
      replaceArray(attendance, records);
      replaceArray(corrections, []);
      replaceArray(decisions, []);
      records.forEach(function (record) {
        (record.corrections || []).forEach(function (correction) {
          corrections.push({
            id: correction.id,
            attendanceId: String(correction.attendance_id),
            requesterId: correction.requester_id,
            requesterRole: correction.requester_role,
            explanation: correction.explanation || "",
            status: correction.status,
            createdAt: correction.created_at || "",
            resolvedAt: correction.resolved_at || "",
          });
        });
        (record.decisions || []).forEach(function (decision) {
          decisions.push({
            id: decision.id,
            attendanceId: String(decision.attendance_id),
            bookingId: record.bookingId,
            correctionId: decision.correction_id ? String(decision.correction_id) : "",
            reviewerId: decision.reviewer_id,
            originalResult: decision.original_result,
            finalResult: decision.final_result,
            decisionType: decision.decision_type,
            decisionLabel: DECISION_LABELS[decision.decision_type] || decision.decision_type,
            reason: decision.reason || "",
            decidedAt: decision.decided_at || "",
          });
        });
      });
    }

    const reviewPayload = valueAt(4);
    if (reviewPayload) {
      replaceArray(reviews, (reviewPayload.data || []).map(mapReview));
    }

    const auditPayload = valueAt(5);
    if (auditPayload) {
      mapAuditLogs(auditPayload.data || []);
      // The total is shown next to the entries, so it is read from the same
      // answer rather than guessed.
      adminAuditTotal = (auditPayload.meta && auditPayload.meta.total) || (auditPayload.data || []).length;
      if (auditPayload.meta && Array.isArray(auditPayload.meta.available_actions)) {
        availableAuditActions = auditPayload.meta.available_actions;
      }
    }

    const holidayPayload = valueAt(6);
    if (holidayPayload) {
      apiAdminHolidays = holidayPayload.data || [];
      platformSettings.holidays.platform = apiAdminHolidays.map(function (holiday) {
        return { id: holiday.id, date: holiday.date, label: holiday.label };
      });
    }

    const termsPayload = valueAt(7);
    if (termsPayload) {
      apiAdminTerms = termsPayload.data || [];
      apiAdminTerms.forEach(function (doc) {
        if (!doc.audience) return;
        if (!doc.version) {
          platformSettings.terms[doc.audience] = null;
          return;
        }
        if (!customTermsPolicies.includes(doc.audience) && !["common", "privacy", "student", "teacher"].includes(doc.audience)) {
          customTermsPolicies.push(doc.audience);
        }
        platformSettings.terms[doc.audience] = {
          role: doc.audience,
          version: doc.version,
          title: doc.title || "",
          body: doc.body || "",
          effectiveDate: doc.effective_date || "",
          publishedAt: doc.published_at || "",
          publishedBy: "Administrator",
          history: (platformSettings.terms[doc.audience] || {}).history || [],
        };
      });
    }

    const settingsPayload = valueAt(8);
    if (settingsPayload && settingsPayload.data) {
      Object.keys(settingsPayload.data).forEach(function (group) {
        if (platformSettings[group] && typeof platformSettings[group] === "object") {
          const incoming = Object.assign({}, settingsPayload.data[group]);
          // The settings group carries only holiday policy. Its `platform`
          // placeholder is empty, so copying it would erase the holiday rows
          // loaded from /admin/holidays immediately afterwards.
          if (group === "holidays") delete incoming.platform;
          // Terms are versioned documents loaded from /admin/terms (and the
          // public meta endpoint), not ordinary settings. The settings payload
          // returns null placeholders, so copying it would hide published terms.
          if (group === "terms") return;
          Object.assign(platformSettings[group], incoming);
        } else if (settingsPayload.data[group] && typeof settingsPayload.data[group] === "object") {
          platformSettings[group] = Object.assign({}, settingsPayload.data[group]);
        }
      });
      if (platformSettings.eligibility) {
        reviewPolicy.configured = !!platformSettings.eligibility.configured;
        reviewPolicy.type = platformSettings.eligibility.type || "study-days";
        reviewPolicy.minConfirmedDays = Number(platformSettings.eligibility.minConfirmedDays || 0);
      }
      applyBranding();
    }

    const rolesPayload = valueAt(9);
    if (rolesPayload) {
      apiAdminRoles = rolesPayload.data || [];
    }

    const whatsappPayload = valueAt(10);
    if (whatsappPayload) {
      apiWhatsappStatus = whatsappPayload.data || null;
    }

    // The data is now current, so a return to the panel does not have to ask
    // the server for the same thing again.
    adminDataLoadedAt = Date.now();
  }

  /**
   * FIX 4 - restore an existing session on page load.
   *
   * loadRoleState() previously ran only from the explicit login handler, so
   * after a refresh — or on any deep link — the app never asked /api/v1/me and
   * never fetched its data. Every API-backed screen rendered empty even though
   * the user was still signed in. A 401 is the normal state for a visitor.
   */
  async function restoreSession() {
    try {
      const payload = await apiRequest("/me");
      applySessionResponse(payload);
      await loadRoleState();
      return true;
    } catch (error) {
      sessionUser = null;
      sessionProfile = null;
      sessionReady = false;
      return false;
    } finally {
      authChecked = true;
    }
  }

  async function loadRoleState() {
    if (!sessionUser) return;
    const role = primaryRole();
    if (role === "student") {
      await Promise.allSettled([loadPublicTeachers(), loadBookings(), loadAttendance(), loadReviews(), loadNotifications()]);
    } else if (role === "teacher") {
      await Promise.allSettled([loadPublicTeachers(), loadBookings(), loadAttendance(), loadReviews(), loadNotifications()]);
    } else if (role === "admin" || role === "super_admin") {
      await Promise.allSettled([loadAdminState(), loadNotifications(), loadPublicTeachers()]);
    }
    updateNotificationBadges();
  }

  async function persistTeacherSection(payload) {
    const response = await apiRequest("/teacher/profile", { method: "PATCH", body: payload });
    if (response.data) applyTeacherProfile(response.data);
    return response.data;
  }

  
  // share these payload builders so every save writes the same fields the API
  // validates and returns.
  function checkedKeys(container, attribute) {
    return Array.from(container.querySelectorAll("[" + attribute + "]:checked")).map(function (input) {
      return input.getAttribute(attribute);
    });
  }

  function teacherBasicsPayload() {
    return {
      name: pName.value.trim(),
      email: pEmail.value.trim(),
      bio: pBio.value.trim(),
    };
  }

  function teacherQualificationsPayload() {
    const qualifications = [];
    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      const values = {};
      row.querySelectorAll("[data-qual-input]").forEach(function (input) {
        values[input.getAttribute("data-qual-input")] = input.value.trim();
      });
      if (!values.name) return;
      qualifications.push({
        name: values.name,
        institution: values.institution || null,
        year: values.year ? Number(values.year) : null,
      });
    });
    return {
      experience_level: expLevel.value || null,
      experience_years: expYears.value.trim() === "" ? null : Number(expYears.value),
      experience_org: expOrg.value.trim() || null,
      experience_description: expDesc.value.trim() || null,
      qualifications: qualifications,
    };
  }

  function teacherSubjectsPayload() {
    const other = gradeGrid.querySelector('[data-grade="other"]');
    return {
      subjects: selectedSubjects().map(function (subject) { return subject.label; }),
      grades: checkedKeys(gradeGrid, "data-grade"),
      streams: checkedKeys(streamGrid, "data-stream"),
      level_other: other && other.checked ? otherLevel.value.trim() : null,
    };
  }

  function teacherLocationPayload() {
    const radiusText = locRadius.value || "";
    const radiusMatch = radiusText.match(/(\d+)/);
    return {
      teaching_mode: selectedMode() || null,
      online_tools: locOnlineTools.value.trim() || null,
      location: {
        area: isInPersonMode() ? (locArea.value.trim() || null) : null,
        city: locCity.value.trim(),
        state: locationStateValue(),
        country: selectedOptionText(locCountry) || locCountry.value,
        radius_km: radiusMatch ? Number(radiusMatch[1]) : 0,
        radius: radiusText || null,
      },
    };
  }

  function teacherAvailabilityPayload() {
    const availability = [];
    selectedDayObjects().forEach(function (day) {
      (availabilitySlots[day.id] || []).forEach(function (slot) {
        if (timeToMinutes(slot.start) === null || timeToMinutes(slot.end) === null) return;
        availability.push({
          day: day.id,
          start_time: slot.start,
          end_time: slot.end,
        });
      });
    });
    return { availability: availability };
  }

  function teacherFullPayload() {
    return Object.assign(
      {},
      teacherBasicsPayload(),
      teacherQualificationsPayload(),
      teacherSubjectsPayload(),
      teacherLocationPayload(),
      teacherAvailabilityPayload()
    );
  }

  async function uploadTeacherPhotoIfChosen() {
    if (!pendingTeacherPhotoFile) return null;
    const form = new FormData();
    form.append("photo", pendingTeacherPhotoFile, pendingTeacherPhotoFile.name || "photo.jpg");
    const response = await apiRequest("/teacher/photo", { method: "POST", body: form });
    pendingTeacherPhotoFile = null;
    const url = response && response.data ? response.data.photo_url : null;
    if (url) applyPhotoUrl(url);
    return url;
  }

  function showTeacherApiError(error, fieldMap) {
    const errors = apiFieldErrors(error);
    let shown = false;
    Object.keys(errors).forEach(function (key) {
      const base = key.split(".")[0];
      const fieldName = fieldMap[base] || fieldMap[key];
      if (!fieldName) return;
      const message = Array.isArray(errors[key]) ? errors[key][0] : errors[key];
      setFieldError(fieldName, String(message));
      shown = true;
    });
    showToast(apiErrorMessage(error));
    return shown;
  }

  const TEACHER_SECTION_FIELDS = {
    basics: { name: "profile-name", email: "profile-email", bio: "profile-bio" },
    qualifications: {
      experience_level: "qual-exp-level",
      experience_years: "qual-exp-years",
      experience_org: "qual-exp-org",
      experience_description: "qual-exp-desc",
    },
    subjects: {
      subjects: "subjects",
      grades: "grades",
      streams: "subject-stream",
      level_other: "subject-grade-other",
    },
    location: {
      teaching_mode: "location-mode",
      online_tools: "loc-online-tools",
      location: "loc-city",
      "location.area": "loc-area",
      "location.city": "loc-city",
      "location.state": "loc-state",
    },
    availability: { availability: "availability-days" },
  };

  async function saveTeacherSection(section) {
    const payload = section === "all"
      ? teacherFullPayload()
      : section === "basics"
        ? teacherBasicsPayload()
        : section === "qualifications"
          ? teacherQualificationsPayload()
          : section === "subjects"
            ? teacherSubjectsPayload()
            : section === "location"
              ? teacherLocationPayload()
              : teacherAvailabilityPayload();
    await uploadTeacherPhotoIfChosen();
    return persistTeacherSection(payload);
  }

  async function saveSettingsGroups(groups) {
    const response = await apiRequest("/admin/settings", {
      method: "PUT",
      body: { settings: groups },
    });
    if (response.data) {
      Object.keys(groups).forEach(function (group) {
        if (!response.data[group]) return;
        // The server is the authority: the local group is replaced by what the
        // server stored, so a setting that no longer exists cannot linger in
        // the browser and be sent back on the next save.
        platformSettings[group] = Object.assign({}, response.data[group]);
      });
      // The holiday rows belong to the holidays endpoint, not to the settings
      // endpoint, so they are put back after a settings save.
      if (platformSettings.holidays) {
        platformSettings.holidays.platform = apiAdminHolidays.map(function (holiday) {
          return { id: holiday.id, date: holiday.date, label: holiday.label };
        });
      }
      if (platformSettings.eligibility) {
        reviewPolicy.configured = !!platformSettings.eligibility.configured;
        reviewPolicy.type = platformSettings.eligibility.type || "study-days";
        reviewPolicy.minConfirmedDays = Number(platformSettings.eligibility.minConfirmedDays || 0);
        reviewPolicy.minCompletedLessons = Number(platformSettings.eligibility.minCompletedLessons || 0);
        reviewPolicy.requireCompletedBooking = platformSettings.eligibility.requireCompletedBooking !== false;
      }
    }
    applyBranding();
    renderContactSections();
    renderTermsLinks();
    if (typeof updateTeacherOtpVisibility === "function") updateTeacherOtpVisibility();
    if (typeof updateStudentOtpVisibility === "function") updateStudentOtpVisibility();
    if (typeof updateForgotPasswordUI === "function") updateForgotPasswordUI();
    return response.data;
  }

  // Everything that belongs to the signed-in account, cleared in one place so
  // a sign-out never leaves another account's data on screen.
  function clearSessionState() {
    sessionUser = null;
    sessionProfile = null;
    sessionReady = false;
    apiTeachers = [];
    replaceArray(bookings, []);
    replaceArray(reviews, []);
    replaceArray(attendance, []);
    replaceArray(corrections, []);
    replaceArray(decisions, []);
    replaceArray(notifications, []);
    studentState.id = "";
    studentState.completed = false;
    loginForm.reset();
    resetTeacherForm();
    resetStudentForm();
  }

  // Signing out is a server action: the browser keeps its session cookie
  // until the server says the session is gone. The local state is therefore
  // only cleared once the server has confirmed the sign-out, so a failed
  // request can never leave the user looking signed out while the session
  // is still valid. The target view decides which sign-in screen is shown.
  async function logoutSession(targetView) {
    if (logoutInFlight) return false;
    logoutInFlight = true;

    let signedOut = false;
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      signedOut = true;
    } catch (error) {
      // 401 means the server holds no session for this browser any more, so
      // the caller is already signed out and the local state still has to go.
      signedOut = Boolean(error && error.status === 401);
      if (!signedOut) {
        console.warn("Logout request failed:", apiErrorMessage(error));
        showToast("We could not sign you out. Please try again.");
      }
    }
    logoutInFlight = false;

    if (!signedOut) return false;

    clearSessionState();
    navigate(targetView || "login");
    showToast("You have been signed out.");

    return true;
  }

  window.App = {
    get session() { return sessionUser; },
    get profile() { return sessionProfile; },
    get ready() { return sessionReady; },
    refresh: refreshSession,
    api: apiRequest,
  };

  /* ============================ Elements ================================ */
  const views = {
    login: document.getElementById("view-login"),
    accountType: document.getElementById("view-account-type"),
    teacher: document.getElementById("view-teacher-signup"),
    profile: document.getElementById("view-teacher-profile"),
    qualifications: document.getElementById("view-qualifications"),
    subjects: document.getElementById("view-subjects"),
    location: document.getElementById("view-location"),
    availability: document.getElementById("view-availability"),
    review: document.getElementById("view-review"),
    dashboard: document.getElementById("view-dashboard"),
    
    student: document.getElementById("view-student-signup"),
    studentLogin: document.getElementById("view-student-login"),
    studentProfile: document.getElementById("view-student-profile"),
    studentReview: document.getElementById("view-student-review"),
    
    studentDashboard: document.getElementById("view-student-dashboard"),
    
    adminReview: document.getElementById("view-admin-review"),
    
    admin: document.getElementById("view-admin"),
    
    terms: document.getElementById("view-terms"),
    forgotPassword: document.getElementById("view-forgot-password"),
  };
  // Each screen has a URL hash so the browser Back/Forward buttons, refresh,
  // and direct links all work. The hashes are prefixed with "#/" so they can't
  // collide with the in-page "#main" skip target.
  const ROUTES = {
    login: { hash: "#/login", title: "Log in" },
    forgotPassword: { hash: "#/forgot-password", title: "Reset Password" },
    accountType: { hash: "#/signup", title: "Create account" },
    teacher: { hash: "#/signup/teacher", title: "Teacher signup" },
    profile: { hash: "#/signup/profile", title: "Teacher profile" },
    qualifications: { hash: "#/signup/qualifications", title: "Qualifications" },
    subjects: { hash: "#/signup/subjects", title: "Subjects" },
    location: { hash: "#/signup/location", title: "Location" },
    availability: { hash: "#/signup/availability", title: "Availability" },
    review: { hash: "#/signup/review", title: "Review profile" },
    dashboard: { hash: "#/dashboard", title: "Dashboard" },
    
    studentLogin: { hash: "#/login/student", title: "Student login" },
    student: { hash: "#/signup/student", title: "Student signup" },
    studentProfile: { hash: "#/signup/student/profile", title: "Student profile" },
    studentReview: { hash: "#/signup/student/review", title: "Student review" },
    
    studentDashboard: { hash: "#/student-dashboard", title: "Student dashboard" },
    
    adminReview: { hash: "#/admin/review", title: "Attendance review" },
    
    admin: { hash: "#/admin", title: "Admin" },
    
    terms: { hash: "#/terms", title: "Terms" },
  };

  // Login
  const loginForm = document.getElementById("login-form");
  const loginEmail = document.getElementById("email");
  const loginPassword = document.getElementById("password");
  const loginBtn = document.getElementById("login-btn");

  // Teacher signup
  const teacherForm = document.getElementById("teacher-form");
  const tName = document.getElementById("t-name");
  const tEmail = document.getElementById("t-email");
  const tPhone = document.getElementById("t-phone");
  const tSendOtpBtn = document.getElementById("t-send-otp-btn");
  const tOtpStatus = document.getElementById("t-otp-status");
  const tOtpCode = document.getElementById("t-otp-code");
  const teacherPhoneField = document.getElementById("teacher-phone-field");
  const teacherOtpField = document.getElementById("teacher-otp-field");
  const tPassword = document.getElementById("t-password");
  const tConfirm = document.getElementById("t-confirm");
  const tTerms = document.getElementById("terms");
  const teacherSubmit = document.getElementById("teacher-submit");
  const signupSuccess = document.getElementById("signup-success");
  const teacherFooter = document.getElementById("teacher-footer");
  const continueToProfile = document.getElementById("continue-to-profile");

  // Teacher profile (, Part 1)
  const profileForm = document.getElementById("profile-form");
  const profileSuccess = document.getElementById("profile-success");
  const profileBack = document.getElementById("profile-back");
  const profileDone = document.getElementById("profile-done");
  const profileEdit = document.getElementById("profile-edit");
  const profileContinue = document.getElementById("profile-continue");
  const pName = document.getElementById("p-name");
  const pBio = document.getElementById("p-bio");
  const pEmail = document.getElementById("p-email");
  const bioCount = document.getElementById("bio-count");
  const photoInput = document.getElementById("photo-input");
  const photoImg = document.getElementById("photo-img");
  const photoPreview = document.getElementById("photo-preview");
  const photoRemove = document.getElementById("photo-remove");

  // Qualifications & experience (, Part 2)
  const qualForm = document.getElementById("qual-form");
  const qualList = document.getElementById("qual-list");
  const qualTemplate = document.getElementById("qual-template");
  const addQualification = document.getElementById("add-qualification");
  const expLevel = document.getElementById("exp-level");
  const expYears = document.getElementById("exp-years");
  const expOrg = document.getElementById("exp-org");
  const expDesc = document.getElementById("exp-desc");
  const expDescCount = document.getElementById("exp-desc-count");
  const qualContinue = document.getElementById("qual-continue");
  const qualBack = document.getElementById("qual-back");
  const qualSuccess = document.getElementById("qual-success");
  const qualEdit = document.getElementById("qual-edit");
  const qualDone = document.getElementById("qual-done");
  const continueToQualifications = document.getElementById("continue-to-qualifications");

  // Subjects & classes (, Part 3)
  const subjectsForm = document.getElementById("subjects-form");
  const subjectGrid = document.getElementById("subject-grid");
  const subjectChips = document.getElementById("subject-chips");
  const subjectSearch = document.getElementById("subject-search");
  const subjectEmpty = document.getElementById("subject-empty");
  const otherSubject = document.getElementById("other-subject");
  const addOtherSubject = document.getElementById("add-other-subject");
  const gradeGrid = document.getElementById("grade-grid");
  const streamGrid = document.getElementById("stream-grid");
  const streamField = document.getElementById("stream-field");
  const otherLevelField = document.getElementById("other-level-field");
  const otherLevel = document.getElementById("other-level");
  const subjectsContinue = document.getElementById("subjects-continue");
  const subjectsBack = document.getElementById("subjects-back");
  const subjectsSuccess = document.getElementById("subjects-success");
  const subjectsEdit = document.getElementById("subjects-edit");
  const subjectsDone = document.getElementById("subjects-done");
  const continueToSubjects = document.getElementById("continue-to-subjects");

  // Location & teaching mode (, Part 4)
  const locationForm = document.getElementById("location-form");
  const modeList = document.getElementById("mode-list");
  const locCountry = document.getElementById("loc-country");
  const locState = document.getElementById("loc-state");
  const locStateLabel = document.getElementById("loc-state-label");
  const locStateControl = document.getElementById("loc-state-control");
  const locStateTextControl = document.getElementById("loc-state-text-control");
  const locStateText = document.getElementById("loc-state-text");
  const locCity = document.getElementById("loc-city");
  const locArea = document.getElementById("loc-area");
  const locAreaField = document.getElementById("loc-area-field");
  const locRadius = document.getElementById("loc-radius");
  const locRadiusField = document.getElementById("loc-radius-field");
  const onlineSection = document.getElementById("online-section");
  const locOnlineTools = document.getElementById("loc-online-tools");
  const onlineToolsCount = document.getElementById("online-tools-count");
  const locationContinue = document.getElementById("location-continue");
  const locationBack = document.getElementById("location-back");
  const locationSuccess = document.getElementById("location-success");
  const locationEdit = document.getElementById("location-edit");
  const locationDone = document.getElementById("location-done");
  const continueToLocation = document.getElementById("continue-to-location");
  const continueToAvailability = document.getElementById("continue-to-availability");

  // Teaching availability (, Part 5)
  const availabilityForm = document.getElementById("availability-form");
  const dayGrid = document.getElementById("day-grid");
  const availabilityDayList = document.getElementById("availability-day-list");
  const availabilityEmpty = document.getElementById("availability-empty");
  const availabilityContinue = document.getElementById("availability-continue");
  const availabilityBack = document.getElementById("availability-back");

  // Profile review & prototype finish (, Part 5)
  const reviewContent = document.getElementById("review-content");
  const reviewList = document.getElementById("review-list");
  const reviewAlert = document.getElementById("review-alert");
  const reviewAlertList = document.getElementById("review-alert-list");
  const reviewBack = document.getElementById("review-back");
  const finishProfile = document.getElementById("finish-profile");
  const reviewComplete = document.getElementById("review-complete");
  const reviewAgain = document.getElementById("review-again");
  const reviewLogin = document.getElementById("review-login");

  // Navigation / placeholders
  const createAccountLink = document.getElementById("create-account-link");
  const chooseTeacher = document.getElementById("choose-teacher");
  const chooseStudent = document.getElementById("choose-student");
  const forgotLink = document.getElementById("forgot-link");
  const termsLink = document.getElementById("terms-link");
  const privacyLink = document.getElementById("privacy-link");
  const backToLoginLinks = [
    document.getElementById("back-to-login-1"),
    document.getElementById("back-to-login-2"),
  ];
  const successBackLogin = document.getElementById("success-back-login");

  // Toast
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-msg");
  const toastClose = document.getElementById("toast-close");

  /* ========================== Small helpers ============================= */
  // Pragmatic email check for UI feedback (not an RFC-exhaustive validator).
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const TEACHER_FIELDS = [
    "teacher-name",
    "teacher-email",
    "teacher-phone",
    "teacher-otp",
    "teacher-password",
    "teacher-confirm",
    "teacher-terms",
  ];

  
  const STUDENT_SIGNUP_FIELDS = [
    "student-name",
    "student-email",
    "student-phone",
    "student-otp",
    "student-password",
    "student-confirm",
    "student-grade",
    "student-grade-other",
    "student-terms",
  ];

  const STUDENT_LOGIN_FIELDS = ["student-login-email", "student-login-password"];

  const STUDENT_PROFILE_FIELDS = [
    "student-photo",
    "student-profile-name",
    "student-profile-email",
    "student-profile-grade",
    "student-profile-grade-other",
    "student-profile-intro",
  ];

  const PROFILE_FIELDS = [
    "profile-photo",
    "profile-name",
    "profile-bio",
    "profile-email",
  ];

  const QUAL_FIELDS = [
    "qual-exp-level",
    "qual-exp-years",
    "qual-exp-org",
    "qual-exp-desc",
  ];

  const SUBJECT_FIELDS = [
    "subjects",
    "subject-other",
    "grades",
    "subject-stream",
    "subject-grade-other",
  ];

  const LOCATION_FIELDS = [
    "location-mode",
    "loc-country",
    "loc-state",
    "loc-city",
    "loc-area",
    "loc-radius",
    "loc-online-tools",
  ];

  const AVAILABILITY_FIELDS = [
    "availability-days",
    "availability-slots",
  ];

  function fieldEl(name) {
    return document.querySelector('[data-field="' + name + '"]');
  }

  // Show or clear the inline error for a field (works for inputs and the checkbox).
  function setFieldError(name, message) {
    const field = fieldEl(name);
    if (!field) return;
    const errorEl = field.querySelector(".field__error");
    if (message) {
      field.classList.add("is-invalid");
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.hidden = false;
        // Re-trigger the shake animation on repeat submits.
        errorEl.style.animation = "none";
        void errorEl.offsetWidth;
        errorEl.style.animation = "";
      }
    } else {
      field.classList.remove("is-invalid");
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.hidden = true;
      }
    }
  }

  /* ============================ Toast =================================== */
  let toastTimer = null;

  function showToast(message) {
    toastMsg.textContent = message;
    toast.hidden = false;
    toast.classList.remove("is-hiding");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5200);
  }

  function hideToast() {
    if (toast.hidden) return;
    toast.classList.add("is-hiding");
    window.setTimeout(function () {
      toast.hidden = true;
      toast.classList.remove("is-hiding");
    }, 250);
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  toastClose.addEventListener("click", hideToast);

  /* ===================== Routing / view switching ======================= */
  let currentView = "login";
  let termsReturnView = "login";

  // Stale validation messages shouldn't greet the user on a newly revealed
  // screen, so every field error is cleared whenever the view changes.
  function clearAllErrors() {
    ["login-email", "login-password"].forEach(function (name) {
      setFieldError(name, "");
    });
    TEACHER_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
    PROFILE_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
    STUDENT_SIGNUP_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
    STUDENT_LOGIN_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
    STUDENT_PROFILE_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
    clearQualificationErrors();
    clearSubjectsErrors();
    clearLocationErrors();
    clearAvailabilityErrors();
    clearReviewFeedback();
  }

  function viewFromHash(hash) {
    const h = String(hash || "").toLowerCase().replace(/\/+$/, "");
    if (h === "#/dashboard" || h.indexOf("#/dashboard/") === 0) return "dashboard";
    // Student dashboard has its own prefix so it can never be confused with
    // the teacher dashboard or the #/signup/student* routes.
    if (h === "#/student-dashboard" || h.indexOf("#/student-dashboard/") === 0) return "studentDashboard";
    if (h === "#/admin/review") return "adminReview";
    // Checked after /admin/review so the console keeps its own route.
    if (h === "#/admin" || h.indexOf("#/admin/") === 0) return "admin";
    if (h === "#/terms") return "terms";
    // Student routes (checked before the matching teacher prefixes).
    if (h === "#/login/student") return "studentLogin";
    if (h === "#/signup/student/profile") return "studentProfile";
    if (h === "#/signup/student/review") return "studentReview";
    if (h === "#/signup/student") return "student";
    if (h === "#/signup/teacher") return "teacher";
    if (h === "#/signup/profile") return "profile";
    if (h === "#/signup/qualifications") return "qualifications";
    if (h === "#/signup/subjects") return "subjects";
    if (h === "#/signup/location") return "location";
    if (h === "#/signup/availability") return "availability";
    if (h === "#/signup/review") return "review";
    if (h === "#/signup") return "accountType";
    if (h === "#/forgot-password") return "forgotPassword";
    if (h === "#/login") return "login";
    return null; // not one of ours (e.g. the "#main" skip target)
  }

  // Every protected screen is guarded here, not only at its link. A deep link
  // or a Back/Forward restore therefore cannot reveal a dashboard, admin panel
  // or profile wizard to a visitor or to the wrong role. The server still
  // authorises every API request; this guard only prevents a misleading empty
  // screen and an unnecessary failing request.
  function authRequirementForView(name) {
    if (name === "admin" || name === "adminReview") return "admin";
    if (["dashboard", "profile", "qualifications", "subjects", "location", "availability", "review"].indexOf(name) !== -1) {
      return "teacher";
    }
    if (["studentDashboard", "studentProfile", "studentReview"].indexOf(name) !== -1) {
      return "student";
    }
    return null;
  }

  function guardView(name) {
    const requirement = authRequirementForView(name);
    if (!requirement) return null;
    if (!sessionUser) {
      return {
        view: requirement === "student" ? "studentLogin" : "login",
        message: "Sign in to continue.",
      };
    }
    const allowed = requirement === "admin"
      ? isAdminSession()
      : requirement === "teacher"
        ? hasRoleName(sessionUser, "teacher")
        : hasRoleName(sessionUser, "student");
    if (allowed) return null;
    return {
      view: homeRouteForRole(),
      message: "You do not have permission to open that screen.",
    };
  }

  // Draw a view. Pure rendering - never touches history.
  function renderView(name, options) {
    const guard = guardView(name);
    if (guard) {
      // Before /me answers there is no honest answer to "is this allowed?".
      // Show the login screen temporarily without touching the URL so a
      // successful restore can still render the requested deep link.
      if (authChecked) {
        // Replace, rather than push, so Back cannot bounce between the guard
        // and the protected URL.
        try {
          history.replaceState({ view: guard.view }, "", ROUTES[guard.view].hash);
        } catch (err) {
          /* the screen can still be shown when history is unavailable */
        }
        showToast(guard.message);
      }
      name = guard.view;
    }
    const target = views[name];
    if (!target) return;
    const opts = options || {};

    // A failure while clearing old validation messages must never block the
    // screen from changing.
    try {
      clearAllErrors();
    } catch (err) {
      /* ignore — navigation is more important than tidying errors */
    }

    Object.keys(views).forEach(function (key) {
      const view = views[key];
      view.hidden = key !== name;
      view.classList.remove("view--enter");
    });

    target.hidden = false;
    // Restart the entrance animation on every switch.
    void target.offsetWidth;
    target.classList.add("view--enter");

    currentView = name;
    const currentBrand = (platformSettings && platformSettings.branding && platformSettings.branding.appName) || "EduPlatform";
    document.title = (ROUTES[name] && ROUTES[name].title) ? ROUTES[name].title.replace(/EduPlatform/g, currentBrand) : currentBrand;

    // Either dashboard replaces the split auth layout entirely.
    if (authShell) {
      authShell.hidden =
        name === "dashboard" || name === "studentDashboard" || name === "admin";
    }
    // The review console and terms reader get the full width instead
    // of the narrow sign-in column.
    if (authShell) authShell.classList.toggle("auth--wide", name === "adminReview" || name === "terms");
    if (name === "terms") {
      const mount = document.getElementById("terms-view-body");
      if (!mount || !mount.innerHTML.trim()) {
        if (typeof populateTermsView === "function") populateTermsView("student");
      }
    }

    // Fill the profile's name/email from the signup form the first time it is
    // opened (in-memory only; never read back from storage).
    if (name === "profile") prefillProfile();

    // Student profile is prefilled once from the signup demo. Returning to it
    // from Review keeps the live form values, so edits are never discarded.
    if (name === "studentProfile") prefillStudentProfile();
    if (name === "studentReview") renderStudentReview();

    // The "login isn't connected yet" note answers one specific submit
    // attempt, so it must not still be on screen when the student returns.
    if (name === "studentLogin") studentLoginNote.hidden = true;
    if (name === "teacher" && typeof updateTeacherOtpVisibility === "function") updateTeacherOtpVisibility();
    if (name === "student" && typeof updateStudentOtpVisibility === "function") updateStudentOtpVisibility();
    if (name === "forgotPassword" && typeof updateForgotPasswordUI === "function") updateForgotPasswordUI();

    // The review is generated from the values currently held in the other
    // sections, so refresh it every time it is shown.
    if (name === "review") renderReview();

    // The dashboard is rebuilt from the current values every time it opens.
    if (name === "dashboard") renderDashboard(opts.focus !== false);

    // The student dashboard reads straight from studentState, so it is rebuilt
    // on every visit and always reflects the latest profile values.
    if (name === "studentDashboard") renderStudentDashboard(opts.focus !== false);

    
    if (name === "adminReview") renderReviewConsole();
    
    if (name === "admin") {
      renderAdmin();
      // The panel holds a snapshot of the data, so coming back to it asks the
      // server for the current records. A load that just happened is still
      // fresh and is not repeated.
      refreshAdminData();
    }

    // Leaving the dashboard while an edit is open discards the unsaved session,
    // exactly like the Cancel button, so half-finished values never leak.
    if (profileEditSession && name !== "dashboard") {
      cancelProfileEdit({ silent: true, announce: true });
    }
    if (subjectsEditSession && name !== "dashboard") {
      cancelSubjectsEdit({ silent: true, announce: true });
    }
    if (availabilityEditSession && name !== "dashboard") {
      cancelAvailabilityEdit({ silent: true, announce: true });
    }

    // Once the dashboard has been opened, offer a way back from the reused
    // profile sections (profile / subjects / availability / review).
    syncBackToDashboard(name);

    // Move focus to the view heading so screen readers and keyboard users
    // land in the new context.
    if (opts.focus !== false) {
      const heading = target.querySelector(".card__title");
      if (heading) heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }

  // Record the route in history. Wrapped in try/catch because some browsers
  // block the History API on file:// URLs — and a throw here must never stop
  // the screen from changing.
  function setRoute(name) {
    const hash = ROUTES[name].hash;
    if (location.hash === hash) return;
    try {
      history.pushState({ view: name }, "", hash);
    } catch (err) {
      try {
        // Fallback: still creates a history entry in most browsers.
        location.hash = hash;
      } catch (err2) {
        /* ignore — the view is rendered by the caller regardless */
      }
    }
  }

  // User-initiated navigation.
  function navigate(name) {
    if (!views[name]) return;
    setRoute(name);
    renderView(name);
  }

  // Browser Back/Forward. Falls back to the hash for entries we didn't create.
  window.addEventListener("popstate", function (event) {
    const name = (event.state && event.state.view) || viewFromHash(location.hash) || "login";
    renderView(name);
  });

  // Fires when the hash changes without pushState (history traversal, or the
  // fallback path above) so Back/Forward still work where the History API is
  // unavailable.
  window.addEventListener("hashchange", function () {
    const name = viewFromHash(location.hash);
    if (!name) return;
    if (name !== currentView) renderView(name);
    // Switching dashboard tabs keeps the same view name, so re-render it.
    else if (name === "dashboard") renderDashboard(true);
    else if (name === "studentDashboard") renderStudentDashboard(true);
    else if (name === "admin") renderAdmin();
  });

  // The brand and skip links point at "#main". Handle them here so they never
  // disturb the route hash (and therefore never pollute history).
  document.querySelectorAll('a[href="#main"]').forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      const target =
        dashboardView && !dashboardView.hidden ? dashboardView : document.getElementById("main");
      if (target) target.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    });
  });

  /* ====================== Password visibility =========================== */
  function resetPasswordToggles() {
    document.querySelectorAll(".toggle-visibility").forEach(function (btn) {
      const input = document.getElementById(btn.getAttribute("aria-controls"));
      if (input) input.type = "password";
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", "Show " + (btn.dataset.noun || "password"));
    });
  }

  document.querySelectorAll(".toggle-visibility").forEach(function (btn) {
    const input = document.getElementById(btn.getAttribute("aria-controls"));
    if (!input) return;
    btn.addEventListener("click", function () {
      const nowVisible = input.type === "password";
      input.type = nowVisible ? "text" : "password";
      btn.setAttribute("aria-pressed", String(nowVisible));
      btn.setAttribute(
        "aria-label",
        (nowVisible ? "Hide " : "Show ") + (btn.dataset.noun || "password")
      );
      input.focus({ preventScroll: true });
    });
  });

  /* ======================== Phone Helpers ================================ */
  function getFullPhone(role) {
    const isStudent = role === "student";
    const countryEl = document.getElementById(isStudent ? "s-phone-country" : "t-phone-country");
    const phoneEl = document.getElementById(isStudent ? "s-phone" : "t-phone");
    const country = countryEl ? countryEl.value : "+91";
    let raw = phoneEl ? (phoneEl.value || "").trim() : "";
    if (!raw) return "";
    if (raw.startsWith("+")) {
      return "+" + raw.replace(/[^0-9]/g, "");
    }
    const cleanDigits = raw.replace(/^0+/, "").replace(/[^0-9]/g, "");
    if (!cleanDigits) return "";
    return country + cleanDigits;
  }

  function validatePhoneNumber(role) {
    const isStudent = role === "student";
    const phoneEl = document.getElementById(isStudent ? "s-phone" : "t-phone");
    const raw = phoneEl ? (phoneEl.value || "").trim() : "";
    if (!raw) return "Phone number is required.";
    const full = getFullPhone(role);
    const digits = full.replace(/[^0-9]/g, "");
    if (digits.length < 8 || digits.length > 15) {
      return "Enter a valid phone number (at least 10 digits).";
    }
    return "";
  }

  /* ======================== Validation rules ============================ */
  function validateEmailValue(value) {
    // The value can come from a stored record, where an address that was
    // never filled in is null rather than an empty string.
    const v = String(value === null || value === undefined ? "" : value).trim();
    if (!v) return "Email address is required.";
    if (!EMAIL_RE.test(v)) return "Enter a valid email, like name@example.com.";
    return "";
  }

  // --- Login ---
  function validateLoginEmail() {
    return validateEmailValue(loginEmail.value);
  }
  function validateLoginPassword() {
    const v = loginPassword.value;
    if (!v) return "Password is required.";
    // The same 12-character minimum the server enforces on signup.
    if (v.length < 12) return "Password must be at least 12 characters.";
    return "";
  }

  // --- Teacher signup ---
  function validateName() {
    const v = tName.value.trim();
    if (!v) return "Full name is required.";
    if (v.length < 2) return "Enter your full name.";
    return "";
  }
  function validateTeacherEmail() {
    return validateEmailValue(tEmail.value);
  }
  function validateTeacherPassword() {
    const v = tPassword.value;
    if (!v) return "Password is required.";
    if (v.length < 12) return "Password must be at least 12 characters.";
    return "";
  }
  function validateConfirm() {
    const v = tConfirm.value;
    if (!v) return "Please confirm your password.";
    if (v !== tPassword.value) return "Passwords do not match.";
    return "";
  }
  function validateTerms() {
    return tTerms.checked
      ? ""
      : "Please accept the Terms of Service and Privacy Policy to continue.";
  }

  // Blur shows an error; typing clears it as soon as the value becomes valid.
  function bindLiveValidation(input, name, validator) {
    input.addEventListener("blur", function () {
      // Validate on blur only once the field has some content. (Not trimmed:
      // passwords may legitimately contain spaces.)
      if (input.value !== "") setFieldError(name, validator());
    });
    input.addEventListener("input", function () {
      if (fieldEl(name).classList.contains("is-invalid") && !validator()) {
        setFieldError(name, "");
      }
    });
  }

  bindLiveValidation(loginEmail, "login-email", validateLoginEmail);
  bindLiveValidation(loginPassword, "login-password", validateLoginPassword);

  bindLiveValidation(tName, "teacher-name", validateName);
  bindLiveValidation(tEmail, "teacher-email", validateTeacherEmail);
  bindLiveValidation(tPassword, "teacher-password", validateTeacherPassword);
  bindLiveValidation(tConfirm, "teacher-confirm", validateConfirm);
  if (tPhone) {
    bindLiveValidation(tPhone, "teacher-phone", function () { return validatePhoneNumber("teacher"); });
  }

  // Keep the confirm field honest while the first password changes.
  tPassword.addEventListener("input", function () {
    if (tConfirm.value && fieldEl("teacher-confirm").classList.contains("is-invalid")) {
      setFieldError("teacher-confirm", validateConfirm());
    }
  });

  tTerms.addEventListener("change", function () {
    if (tTerms.checked) setFieldError("teacher-terms", "");
  });

  /* ========================= Login submit =============================== */
  function setLoginLoading(isLoading) {
    loginBtn.classList.toggle("is-loading", isLoading);
    loginBtn.setAttribute("aria-busy", String(isLoading));
    loginBtn.disabled = isLoading;
    loginBtn.querySelector(".btn__label").textContent = isLoading ? "Logging in…" : "Log in";
  }

  loginForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (loginSubmitting) return; // ignore duplicate submissions

    const emailMessage = validateLoginEmail();
    const passwordMessage = validateLoginPassword();

    setFieldError("login-email", emailMessage);
    setFieldError("login-password", passwordMessage);

    if (emailMessage || passwordMessage) {
      (emailMessage ? loginEmail : loginPassword).focus({ preventScroll: true });
      return;
    }

    loginSubmitting = true;
    setLoginLoading(true);
    apiRequest("/auth/login", {
      method: "POST",
      body: {
        email: loginEmail.value.trim(),
        password: loginPassword.value,
      },
    }).then(async function (payload) {
      applySessionResponse(payload);
      await loadRoleState();
      loginPassword.value = "";
      resetPasswordToggles();
      const destination = homeRouteForRole();
      navigate(destination);
      showToast("Signed in as " + (sessionUser ? sessionUser.name : "your account") + ".");
    }).catch(function (error) {
      const errors = apiFieldErrors(error);
      if (errors.email) setFieldError("login-email", String(errors.email[0]));
      if (errors.password) setFieldError("login-password", String(errors.password[0]));
      if (!errors.email && !errors.password) showToast(apiErrorMessage(error));
    }).finally(function () {
      setLoginLoading(false);
      loginSubmitting = false;
    });
  });

  /* ====================== Teacher signup submit ========================= */
  let teacherSubmitting = false;

  function setTeacherLoading(isLoading) {
    teacherSubmit.classList.toggle("is-loading", isLoading);
    teacherSubmit.setAttribute("aria-busy", String(isLoading));
    teacherSubmit.disabled = isLoading;
    teacherSubmit.querySelector(".btn__label").textContent = isLoading
      ? "Creating account…"
      : "Create Teacher Account";
  }

  function resetTeacherForm() {
    teacherForm.reset();
    teacherForm.hidden = false;
    teacherFooter.hidden = false;
    signupSuccess.hidden = true;
    TEACHER_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
    teacherSubmitting = false;
    setTeacherLoading(false);
    resetPasswordToggles();
  }

  teacherForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (teacherSubmitting) return; // ignore duplicate submissions

    const reqOtp = Boolean(platformSettings.otp && platformSettings.otp.enabled && platformSettings.otp.requireRegistrationOtp);
    const checks = [
      ["teacher-name", validateName(), tName],
      ["teacher-email", validateTeacherEmail(), tEmail],
      ["teacher-password", validateTeacherPassword(), tPassword],
      ["teacher-confirm", validateConfirm(), tConfirm],
      ["teacher-terms", validateTerms(), tTerms],
    ];

    const phoneFull = getFullPhone("teacher");
    checks.push(["teacher-phone", validatePhoneNumber("teacher"), tPhone]);
    if (reqOtp) {
      const otpVal = (tOtpCode ? tOtpCode.value : "").trim();
      checks.push(["teacher-otp", (otpVal.length !== 6 ? "Please enter the 6-digit WhatsApp OTP code." : ""), tOtpCode]);
    }

    let firstInvalid = null;
    checks.forEach(function (item) {
      const name = item[0];
      const message = item[1];
      const input = item[2];
      setFieldError(name, message);
      if (message && !firstInvalid) firstInvalid = input;
    });

    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      return;
    }

    teacherSubmitting = true;
    setTeacherLoading(true);
    const bodyData = {
      name: tName.value.trim(),
      email: tEmail.value.trim(),
      password: tPassword.value,
      password_confirmation: tConfirm.value,
      accept_terms: tTerms.checked,
      phone: phoneFull,
    };
    if (reqOtp && tOtpCode) bodyData.otp_code = tOtpCode.value.trim();

    apiRequest("/auth/register/teacher", {
      method: "POST",
      body: bodyData,
    }).then(async function (payload) {
      applySessionResponse(payload);
      // The sign-up signs the new teacher in, so the signed-in data is
      // loaded right away. Without it the dashboard opened with empty lists
      // until the page was refreshed.
      await loadRoleState();
      tPassword.value = "";
      tConfirm.value = "";
      resetPasswordToggles();
      teacherForm.hidden = true;
      teacherFooter.hidden = true;
      signupSuccess.hidden = false;
      signupSuccess.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }).catch(function (error) {
      const errors = apiFieldErrors(error);
      const map = {
        name: "teacher-name",
        email: "teacher-email",
        phone: "teacher-phone",
        otp_code: "teacher-otp",
        password: "teacher-password",
        accept_terms: "teacher-terms",
      };
      let firstField = null;
      Object.keys(map).forEach(function (key) {
        if (errors[key] && errors[key].length) {
          setFieldError(map[key], String(errors[key][0]));
          if (!firstField) firstField = document.querySelector('[data-field="' + map[key] + '"] input');
        }
      });
      if (!firstField && !Object.keys(errors).length) showToast(apiErrorMessage(error));
      if (firstField) firstField.focus({ preventScroll: true });
    }).finally(function () {
      setTeacherLoading(false);
      teacherSubmitting = false;
    });
  });

  function updateTeacherOtpVisibility() {
    const reqOtp = Boolean(platformSettings.otp && platformSettings.otp.enabled && platformSettings.otp.requireRegistrationOtp);
    if (teacherPhoneField) {
      const label = teacherPhoneField.querySelector(".field__label");
      if (label) label.textContent = reqOtp ? "Phone Number Verification" : "Phone Number";
    }
    if (tSendOtpBtn) tSendOtpBtn.hidden = !reqOtp;
    if (teacherOtpField) {
      teacherOtpField.hidden = !reqOtp;
      if (!reqOtp) {
        setFieldError("teacher-otp", "");
      }
    }
  }

  if (tSendOtpBtn) {
    tSendOtpBtn.addEventListener("click", async function () {
      const phone = getFullPhone("teacher");
      const err = validatePhoneNumber("teacher");
      if (err) {
        setFieldError("teacher-phone", err);
        if (tPhone) tPhone.focus();
        return;
      }
      setFieldError("teacher-phone", "");
      tSendOtpBtn.disabled = true;
      tSendOtpBtn.textContent = "Sending...";
      try {
        const res = await apiRequest("/auth/otp/send", {
          method: "POST",
          body: { phone: phone },
        });
        if (tOtpStatus) {
          tOtpStatus.hidden = false;
          let msg = res.data && res.data.code
            ? "OTP generated! Test code: " + res.data.code
            : (res.data && res.data.message) || "OTP sent to your WhatsApp number.";
          tOtpStatus.textContent = msg;
        }
        if (teacherOtpField) teacherOtpField.hidden = false;
        if (tOtpCode) tOtpCode.focus();
        showToast("OTP verification code requested.");
      } catch (err) {
        setFieldError("teacher-phone", apiErrorMessage(err) || "Failed to send OTP.");
      } finally {
        tSendOtpBtn.disabled = false;
        tSendOtpBtn.textContent = "Send OTP";
      }
    });
  }

  /* ========================== Navigation =============================== */
  createAccountLink.addEventListener("click", function () {
    navigate("accountType");
  });

  // Moving between screens keeps whatever has been typed (held in memory only)
  // so nothing is lost. Passwords are never written to browser storage.
  chooseTeacher.addEventListener("click", function () {
    navigate("teacher");
  });

  chooseStudent.addEventListener("click", function () {
    navigate("student");
  });

  backToLoginLinks.forEach(function (link) {
    if (!link) return;
    link.addEventListener("click", function () {
      navigate("login");
    });
  });

  // The demo flow finished: clear the form so the next visit starts fresh.
  successBackLogin.addEventListener("click", function () {
    resetTeacherForm();
    navigate("login");
  });

  // Escape: dismiss the notice first, otherwise step back to login from a
  // signup screen — but never while the user is typing in a text field, so it
  // can't yank them out of the form mid-edit.
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (!toast.hidden) {
      hideToast();
      return;
    }
    // On either dashboard, Escape closes the mobile menu or steps back to the
    // dashboard home — it never yanks the user out to the login screen.
    if (currentView === "dashboard") {
      if (dashNavOpen) {
        setDashNav(false);
        return;
      }
      // An open edit session is dismissed first (same as Cancel) so Escape
      // never throws away the profile overview itself.
      if (profileEditSession) {
        cancelProfileEdit();
        return;
      }
      if (subjectsEditSession) {
        cancelSubjectsEdit();
        return;
      }
      if (dashTabFromHash(location.hash) !== "home") {
        showDashTab("home");
      }
      return;
    }
    // The student dashboard mirrors this: Escape closes the mobile menu and
    // otherwise stays put. It deliberately does not step away from a sub-screen
    // because the Find Teachers panel has search fields the student may be
    // typing in when they press Escape.
    if (currentView === "studentDashboard") {
      if (sdashNavOpen) setStudentDashNav(false);
      return;
    }
    const el = document.activeElement;
    const isTextField =
      el &&
      el.tagName === "INPUT" &&
      ["text", "email", "password", "search", "tel", "url"].indexOf(el.type) !== -1;
    if (isTextField) return;
    // Student screens step back within the student flow rather than jumping
    // straight out to the teacher login.
    if (currentView === "studentReview") {
      navigate("studentProfile");
      return;
    }
    if (currentView === "studentProfile") {
      navigate("student");
      return;
    }
    if (currentView === "terms") {
      navigate(termsReturnView || "login");
      return;
    }
    if (currentView === "studentLogin" || currentView === "student") {
      navigate("accountType");
      return;
    }
    if (currentView !== "login") {
      navigate("login");
    }
  });

  /* ================= Teacher profile basics (, Part 1) ========== */
  const BIO_MAX = 300;
  const BIO_MIN = 20;
  const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
  let profileSubmitting = false;
  let photoObjectUrl = null;
  let pendingTeacherPhotoFile = null;
  // During an edit session the previous preview URL is held back (not revoked)
  // so Cancel can restore it; the list is flushed when the session ends.
  let photoUrlsToRelease = [];
  let profileEditSession = null; // non-null only while My Profile is being edited
  let subjectsEditSession = null; // non-null only while My Subjects is being edited

  // Shared character counter, reused by the bio and the experience description.
  function bindCharCounter(input, counter, max) {
    function update() {
      // maxlength blocks over-typing, but clamp anyway so the counter can
      // never disagree with the real value.
      if (input.value.length > max) input.value = input.value.slice(0, max);
      const len = input.value.length;
      counter.textContent = len + " / " + max;
      counter.classList.toggle("is-near", len >= max - 20 && len < max);
      counter.classList.toggle("is-full", len >= max);
    }
    input.addEventListener("input", update);
    return update;
  }

  const updateBioCount = bindCharCounter(pBio, bioCount, BIO_MAX);

  // Carry the signup details across so the teacher doesn't retype them.
  function prefillProfile() {
    if (!pName.value && tName.value.trim()) pName.value = tName.value.trim();
    if (!pEmail.value && tEmail.value.trim()) pEmail.value = tEmail.value.trim();
    updateBioCount();
  }

  function validateProfileName() {
    const v = pName.value.trim();
    if (!v) return "Full name is required.";
    if (v.length < 2) return "Enter your full name.";
    return "";
  }

  function validateProfileBio() {
    const v = pBio.value.trim();
    if (!v) return "A short bio is required.";
    if (v.length < BIO_MIN) {
      return "Please write at least " + BIO_MIN + " characters (" + v.length + " so far).";
    }
    return "";
  }

  function validateProfileEmail() {
    return validateEmailValue(pEmail.value);
  }

  function validatePhotoFile(file) {
    if (!file.type || file.type.indexOf("image/") !== 0) {
      return "That file isn't an image. Choose a JPG, PNG or WebP file.";
    }
    if (file.size > PHOTO_MAX_BYTES) {
      return (
        "That image is too large (" +
        (file.size / 1024 / 1024).toFixed(1) +
        " MB). Choose one under 2 MB."
      );
    }
    return "";
  }

  function setPhoto(file) {
    if (photoObjectUrl) {
      if (profileEditSession) photoUrlsToRelease.push(photoObjectUrl);
      else URL.revokeObjectURL(photoObjectUrl);
    }
    pendingTeacherPhotoFile = file || null;
    photoObjectUrl = URL.createObjectURL(file);
    photoImg.src = photoObjectUrl;
    photoImg.hidden = false;
    photoPreview.classList.add("has-image");
    photoRemove.hidden = false;
  }

  function clearPhoto() {
    pendingTeacherPhotoFile = null;
    if (photoObjectUrl) {
      if (profileEditSession) photoUrlsToRelease.push(photoObjectUrl);
      else URL.revokeObjectURL(photoObjectUrl);
      photoObjectUrl = null;
    }
    photoImg.removeAttribute("src");
    photoImg.hidden = true;
    photoPreview.classList.remove("has-image");
    photoRemove.hidden = true;
    photoInput.value = "";
    setFieldError("profile-photo", "");
  }

  photoInput.addEventListener("change", function () {
    const file = photoInput.files && photoInput.files[0];
    if (!file) return;
    const message = validatePhotoFile(file);
    if (message) {
      setFieldError("profile-photo", message);
      // Clear the picker so the same file can be chosen again; keep any
      // previously selected preview rather than throwing it away.
      photoInput.value = "";
      return;
    }
    setFieldError("profile-photo", "");
    setPhoto(file);
  });

  photoRemove.addEventListener("click", clearPhoto);

  bindLiveValidation(pName, "profile-name", validateProfileName);
  bindLiveValidation(pEmail, "profile-email", validateProfileEmail);
  bindLiveValidation(pBio, "profile-bio", validateProfileBio);

  function setProfileLoading(isLoading) {
    profileContinue.classList.toggle("is-loading", isLoading);
    profileContinue.setAttribute("aria-busy", String(isLoading));
    profileContinue.disabled = isLoading;
    profileContinue.querySelector(".btn__label").textContent = isLoading ? "Saving…" : "Continue";
  }

  profileForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (profileSubmitting) return; // ignore duplicate submissions

    const checks = [
      ["profile-name", validateProfileName(), pName],
      ["profile-bio", validateProfileBio(), pBio],
      ["profile-email", validateProfileEmail(), pEmail],
    ];

    let firstInvalid = null;
    checks.forEach(function (item) {
      setFieldError(item[0], item[1]);
      if (item[1] && !firstInvalid) firstInvalid = item[2];
    });

    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      return;
    }

    profileSubmitting = true;
    setProfileLoading(true);
    saveTeacherSection("basics")
      .then(function () {
        profileForm.hidden = true;
        profileSuccess.hidden = false;
        profileSuccess.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      })
      .catch(function (error) {
        showTeacherApiError(error, TEACHER_SECTION_FIELDS.basics);
      })
      .finally(function () {
        setProfileLoading(false);
        profileSubmitting = false;
      });
  });

  // Prototype-only continuation from the demo signup screen.
  continueToProfile.addEventListener("click", function () {
    navigate("profile");
  });

  profileBack.addEventListener("click", function () {
    navigate("teacher");
  });

  profileEdit.addEventListener("click", function () {
    profileSuccess.hidden = true;
    profileForm.hidden = false;
    pName.focus({ preventScroll: true });
  });

  profileDone.addEventListener("click", function () {
    // Restore the form so returning later shows the details, then leave.
    profileSuccess.hidden = true;
    profileForm.hidden = false;
    navigate("login");
  });

  /* ============ Qualifications & experience (, Part 2) =========== */
  const EXP_DESC_MAX = 240;
  const YEAR_MIN = 1950;
  let qualSeq = 0;
  let qualSubmitting = false;

  // Each experience level defines the range of years it is consistent with.
  // Used only to cross-check the two fields — nothing is ever auto-filled.
  const LEVEL_RANGES = {
    fresher: { min: 0, max: 0, label: "Fresher" },
    lt1: { min: 0, max: 1, label: "Less than 1 year" },
    "1-3": { min: 1, max: 3, label: "1–3 years" },
    "3-5": { min: 3, max: 5, label: "3–5 years" },
    "5plus": { min: 5, max: 60, label: "5+ years" },
  };

  bindCharCounter(expDesc, expDescCount, EXP_DESC_MAX);

  /* ------------------- repeatable qualification rows ------------------- */
  function renumberQualifications() {
    const rows = qualList.querySelectorAll("[data-qual]");
    rows.forEach(function (row, i) {
      const num = row.querySelector("[data-qual-num]");
      if (num) num.textContent = String(i + 1);
      const remove = row.querySelector("[data-qual-remove]");
      if (remove) remove.hidden = rows.length <= 1; // always keep one row
    });
  }

  function setRowError(input, message) {
    const field = input.closest(".field");
    if (!field) return;
    const error = field.querySelector(".field__error");
    if (message) {
      field.classList.add("is-invalid");
      if (error) { error.textContent = message; error.hidden = false; }
    } else {
      field.classList.remove("is-invalid");
      if (error) { error.textContent = ""; error.hidden = true; }
    }
  }

  function validateQualField(key, value) {
    const v = String(value).trim();
    if (key === "name") {
      if (!v) return "Qualification or degree name is required.";
      if (v.length < 2) return "Enter the full qualification name.";
      return "";
    }
    if (key === "institution") {
      if (!v) return "Institution or university is required.";
      if (v.length < 2) return "Enter the full institution name.";
      return "";
    }
    if (key === "year") {
      if (!v) return "Year of completion is required.";
      if (!/^\d{4}$/.test(v)) return "Enter a 4-digit year, like 2019.";
      const year = parseInt(v, 10);
      const thisYear = new Date().getFullYear();
      if (year < YEAR_MIN) return "Enter a year from " + YEAR_MIN + " onwards.";
      if (year > thisYear) {
        return "Year can't be in the future (the current year is " + thisYear + ").";
      }
      return "";
    }
    return "";
  }

  function validateQualRow(row) {
    let firstInvalid = null;
    row.querySelectorAll("[data-qual-input]").forEach(function (input) {
      const key = input.getAttribute("data-qual-input");
      const message = validateQualField(key, input.value);
      setRowError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    });
    return firstInvalid;
  }

  function clearQualificationErrors() {
    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      row.querySelectorAll("[data-qual-input]").forEach(function (input) {
        setRowError(input, "");
      });
    });
    QUAL_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
  }

  // Build one qualification row from the <template>, wiring ids/labels/ARIA
  // (ids come from a running counter so they stay stable as rows are removed).
  function addQualificationRow(values) {
    const frag = qualTemplate.content.cloneNode(true);
    const row = frag.querySelector("[data-qual]");
    const uid = "qual-" + ++qualSeq;

    row.querySelectorAll("[data-qual-input]").forEach(function (input) {
      const key = input.getAttribute("data-qual-input");
      const id = uid + "-" + key;
      input.id = id;

      const label = row.querySelector('[data-qual-label="' + key + '"]');
      if (label) label.setAttribute("for", id);

      const error = row.querySelector('[data-qual-error="' + key + '"]');
      if (error) {
        error.id = id + "-error";
        input.setAttribute("aria-describedby", error.id);
      }

      if (values && values[key] != null) input.value = values[key];

      input.addEventListener("input", function () {
        if (!validateQualField(key, input.value)) setRowError(input, "");
      });
    });

    qualList.appendChild(row);
    renumberQualifications();
    return row;
  }

  addQualification.addEventListener("click", function () {
    const row = addQualificationRow();
    const first = row.querySelector("[data-qual-input]");
    if (first) first.focus({ preventScroll: true });
  });

  qualList.addEventListener("click", function (event) {
    const target = event.target;
    if (!target || !target.closest) return;
    const btn = target.closest("[data-qual-remove]");
    if (!btn) return;
    if (qualList.querySelectorAll("[data-qual]").length <= 1) return;
    btn.closest("[data-qual]").remove();
    renumberQualifications();
  });

  /* ------------------------- experience fields ------------------------- */
  function validateExpLevel() {
    return expLevel.value ? "" : "Select your experience level.";
  }

  function validateExpYears() {
    const raw = expYears.value.trim();
    if (raw === "") return "Total years of teaching experience is required.";
    const years = Number(raw);
    if (!isFinite(years) || years < 0) return "Enter a number of years (0 or more).";
    if (years > 60) return "Enter a number of years up to 60.";

    const range = LEVEL_RANGES[expLevel.value];
    if (range && (years < range.min || years > range.max)) {
      if (range.min === range.max) {
        return "For '" + range.label + "', years of experience should be " + range.min + ".";
      }
      return (
        "For '" + range.label + "', enter between " + range.min + " and " + range.max + " years."
      );
    }
    return "";
  }

  bindLiveValidation(expYears, "qual-exp-years", validateExpYears);

  expLevel.addEventListener("change", function () {
    setFieldError("qual-exp-level", "");
    // Keep the pair consistent: re-check the years against the chosen level.
    if (expYears.value.trim() !== "") setFieldError("qual-exp-years", validateExpYears());
  });

  function setQualLoading(isLoading) {
    qualContinue.classList.toggle("is-loading", isLoading);
    qualContinue.setAttribute("aria-busy", String(isLoading));
    qualContinue.disabled = isLoading;
    qualContinue.querySelector(".btn__label").textContent = isLoading ? "Saving…" : "Continue";
  }

  qualForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (qualSubmitting) return; // ignore duplicate submissions

    let firstInvalid = null;

    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      const invalid = validateQualRow(row);
      if (invalid && !firstInvalid) firstInvalid = invalid;
    });

    const levelMessage = validateExpLevel();
    const yearsMessage = validateExpYears();
    setFieldError("qual-exp-level", levelMessage);
    setFieldError("qual-exp-years", yearsMessage);
    if (levelMessage && !firstInvalid) firstInvalid = expLevel;
    if (yearsMessage && !firstInvalid) firstInvalid = expYears;

    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      return;
    }

    qualSubmitting = true;
    setQualLoading(true);
    saveTeacherSection("qualifications")
      .then(function () {
        qualForm.hidden = true;
        qualSuccess.hidden = false;
        qualSuccess.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      })
      .catch(function (error) {
        showTeacherApiError(error, TEACHER_SECTION_FIELDS.qualifications);
      })
      .finally(function () {
        setQualLoading(false);
        qualSubmitting = false;
      });
  });

  // Prototype-only continuation from the profile-basics notice.
  continueToQualifications.addEventListener("click", function () {
    navigate("qualifications");
  });

  qualBack.addEventListener("click", function () {
    navigate("profile");
  });

  qualEdit.addEventListener("click", function () {
    qualSuccess.hidden = true;
    qualForm.hidden = false;
    const first = qualList.querySelector("[data-qual-input]");
    if (first) first.focus({ preventScroll: true });
  });

  qualDone.addEventListener("click", function () {
    qualSuccess.hidden = true;
    qualForm.hidden = false;
    navigate("login");
  });

  /* ============== Subjects & classes (, Part 3) ================== */
  const COMMON_SUBJECTS = [
    { id: "mathematics", label: "Mathematics" },
    { id: "science", label: "Science" },
    { id: "physics", label: "Physics" },
    { id: "chemistry", label: "Chemistry" },
    { id: "biology", label: "Biology" },
    { id: "english", label: "English" },
    { id: "hindi", label: "Hindi" },
    { id: "computer-science", label: "Computer Science" },
    { id: "social-studies", label: "Social Studies" },
    { id: "economics", label: "Economics" },
  ];

  const GRADE_OPTIONS = [
    { id: "1-5", label: "Classes 1–5" },
    { id: "6-8", label: "Classes 6–8" },
    { id: "9-10", label: "Classes 9–10" },
    { id: "11-12", label: "Classes 11–12" },
    { id: "other", label: "Other level" },
  ];

  const STREAM_OPTIONS = [
    { id: "science", label: "Science" },
    { id: "commerce", label: "Commerce" },
    { id: "arts", label: "Arts / Humanities" },
  ];

  let customSubjects = []; // in-memory only, never persisted
  let subjectsSubmitting = false;

  // One renderer builds the subject, grade and stream checkbox lists from data,
  // so the option markup exists in exactly one place.
  function renderCheckList(container, items, dataAttr, idPrefix) {
    container.innerHTML = "";
    items.forEach(function (item) {
      const label = document.createElement("label");
      label.className = "check-item";
      if (dataAttr === "subject") {
        label.setAttribute("data-subject-label", item.label.toLowerCase());
      }

      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = idPrefix + "-" + item.id;
      input.value = item.id;
      input.setAttribute("data-" + dataAttr, item.id);

      const text = document.createElement("span");
      text.className = "check-item__label";
      text.textContent = item.label;

      label.appendChild(input);
      label.appendChild(text);
      container.appendChild(label);
    });
  }

  function syncCheckStates() {
    [subjectGrid, gradeGrid, streamGrid, dayGrid].forEach(function (grid) {
      grid.querySelectorAll(".check-item").forEach(function (label) {
        const input = label.querySelector("input");
        label.classList.toggle("is-checked", !!(input && input.checked));
      });
    });
  }

  /* ------------------------------ subjects ----------------------------- */
  function selectedSubjects() {
    const out = [];
    subjectGrid.querySelectorAll("[data-subject]:checked").forEach(function (input) {
      const found = COMMON_SUBJECTS.filter(function (s) { return s.id === input.value; })[0];
      if (found) out.push({ key: found.id, label: found.label, common: true });
    });
    customSubjects.forEach(function (c) {
      out.push({ key: c.key, label: c.label, common: false });
    });
    return out;
  }

  function renderSubjectChips() {
    const list = selectedSubjects();
    subjectChips.innerHTML = "";
    subjectChips.hidden = list.length === 0;

    list.forEach(function (s) {
      const chip = document.createElement("span");
      chip.className = "chip";

      const text = document.createElement("span");
      text.textContent = s.label;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip__remove";
      remove.setAttribute("aria-label", "Remove " + s.label);
      remove.innerHTML = '<svg width="12" height="12" aria-hidden="true"><use href="#i-close" /></svg>';
      remove.addEventListener("click", function () {
        if (s.common) {
          const input = subjectGrid.querySelector('[data-subject="' + s.key + '"]');
          if (input) input.checked = false;
        } else {
          customSubjects = customSubjects.filter(function (c) { return c.key !== s.key; });
        }
        renderSubjectChips();
        syncCheckStates();
        setFieldError("subjects", "");
      });

      chip.appendChild(text);
      chip.appendChild(remove);
      subjectChips.appendChild(chip);
    });
  }

  function filterSubjects() {
    const q = subjectSearch.value.trim().toLowerCase();
    let shown = 0;
    subjectGrid.querySelectorAll("[data-subject-label]").forEach(function (label) {
      const match = !q || label.getAttribute("data-subject-label").indexOf(q) !== -1;
      label.hidden = !match;
      if (match) shown += 1;
    });
    subjectEmpty.hidden = shown !== 0;
  }

  subjectSearch.addEventListener("input", filterSubjects);

  // The search box and the "add your own subject" box are scratch inputs, not
  // shared profile data. Clear them when a dashboard edit session ends so a
  // cancelled edit can't leave the subject grid filtered or a half-typed
  // subject sitting in the field.
  function resetSubjectsScratch() {
    subjectSearch.value = "";
    otherSubject.value = "";
    filterSubjects();
    setFieldError("subject-other", "");
  }

  subjectGrid.addEventListener("change", function () {
    renderSubjectChips();
    syncCheckStates();
    setFieldError("subjects", "");
  });

  function addCustomSubject() {
    const label = otherSubject.value.trim().replace(/\s+/g, " ");
    if (!label) {
      setFieldError("subject-other", "Type a subject name first, or leave this blank.");
      return;
    }

    // Reuse the canonical entry instead of creating a near-duplicate.
    const key = label.toLowerCase();
    const common = COMMON_SUBJECTS.filter(function (s) {
      return s.label.toLowerCase() === key;
    })[0];
    if (common) {
      const input = subjectGrid.querySelector('[data-subject="' + common.id + '"]');
      if (input) input.checked = true;
      otherSubject.value = "";
      setFieldError("subject-other", "");
      renderSubjectChips();
      syncCheckStates();
      setFieldError("subjects", "");
      return;
    }

    if (customSubjects.some(function (c) { return c.key === "custom:" + key; })) {
      setFieldError("subject-other", "\u201C" + label + "\u201D is already in your list.");
      return;
    }

    customSubjects.push({ key: "custom:" + key, label: label });
    otherSubject.value = "";
    setFieldError("subject-other", "");
    renderSubjectChips();
    setFieldError("subjects", "");
  }

  addOtherSubject.addEventListener("click", addCustomSubject);
  otherSubject.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault(); // add the subject rather than submitting the form
      addCustomSubject();
    }
  });
  otherSubject.addEventListener("input", function () {
    if (otherSubject.value.trim()) setFieldError("subject-other", "");
  });

  /* ------------------- grades, streams, other level -------------------- */
  function toggleConditionalFields() {
    const eleven = gradeGrid.querySelector('[data-grade="11-12"]');
    const other = gradeGrid.querySelector('[data-grade="other"]');
    streamField.hidden = !(eleven && eleven.checked);
    otherLevelField.hidden = !(other && other.checked);
  }

  gradeGrid.addEventListener("change", function (event) {
    const input = event.target;
    if (!input || input.type !== "checkbox") return;
    toggleConditionalFields();
    syncCheckStates();
    setFieldError("grades", "");
    if (input.getAttribute("data-grade") === "11-12" && !input.checked) {
      setFieldError("subject-stream", "");
    }
    if (input.getAttribute("data-grade") === "other" && !input.checked) {
      setFieldError("subject-grade-other", "");
    }
  });

  streamGrid.addEventListener("change", function () {
    syncCheckStates();
    setFieldError("subject-stream", "");
  });

  otherLevel.addEventListener("input", function () {
    if (otherLevel.value.trim()) setFieldError("subject-grade-other", "");
  });

  /* ----------------------------- validation ---------------------------- */
  function validateSubjects() {
    return selectedSubjects().length ? "" : "Select at least one subject you teach.";
  }
  function validateGrades() {
    return gradeGrid.querySelectorAll("[data-grade]:checked").length
      ? ""
      : "Select at least one class or level you teach.";
  }
  function validateStreams() {
    const eleven = gradeGrid.querySelector('[data-grade="11-12"]');
    if (!eleven || !eleven.checked) return "";
    return streamGrid.querySelectorAll("[data-stream]:checked").length
      ? ""
      : "Select at least one stream for Classes 11–12.";
  }
  function validateOtherLevel() {
    const other = gradeGrid.querySelector('[data-grade="other"]');
    if (!other || !other.checked) return "";
    return otherLevel.value.trim() ? "" : "Tell us which other level you teach.";
  }

  function clearSubjectsErrors() {
    SUBJECT_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
  }

  function setSubjectsLoading(isLoading) {
    subjectsContinue.classList.toggle("is-loading", isLoading);
    subjectsContinue.setAttribute("aria-busy", String(isLoading));
    subjectsContinue.disabled = isLoading;
    subjectsContinue.querySelector(".btn__label").textContent = isLoading ? "Saving…" : "Continue";
  }

  subjectsForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (subjectsSubmitting) return; // ignore duplicate submissions

    const checks = [
      ["subjects", validateSubjects(), subjectGrid],
      ["grades", validateGrades(), gradeGrid],
      ["subject-stream", validateStreams(), streamGrid],
      ["subject-grade-other", validateOtherLevel(), otherLevel],
    ];

    let firstInvalid = null;
    checks.forEach(function (item) {
      setFieldError(item[0], item[1]);
      if (item[1] && !firstInvalid) firstInvalid = item[2];
    });

    if (firstInvalid) {
      // Checkbox groups aren't focusable themselves — focus their first option.
      const target = firstInvalid.matches && firstInvalid.matches("input")
        ? firstInvalid
        : firstInvalid.querySelector("input");
      if (target) target.focus({ preventScroll: true });
      else window.scrollTo(0, 0);
      return;
    }

    subjectsSubmitting = true;
    setSubjectsLoading(true);
    saveTeacherSection("subjects")
      .then(function () {
        subjectsForm.hidden = true;
        subjectsSuccess.hidden = false;
        subjectsSuccess.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      })
      .catch(function (error) {
        showTeacherApiError(error, TEACHER_SECTION_FIELDS.subjects);
      })
      .finally(function () {
        setSubjectsLoading(false);
        subjectsSubmitting = false;
      });
  });

  // Prototype-only continuation from the qualifications notice.
  continueToSubjects.addEventListener("click", function () {
    navigate("subjects");
  });

  subjectsBack.addEventListener("click", function () {
    navigate("qualifications");
  });

  subjectsEdit.addEventListener("click", function () {
    subjectsSuccess.hidden = true;
    subjectsForm.hidden = false;
    subjectSearch.focus({ preventScroll: true });
  });

  subjectsDone.addEventListener("click", function () {
    subjectsSuccess.hidden = true;
    subjectsForm.hidden = false;
    navigate("login");
  });

  /* ========= Location & teaching mode (, Part 4) ================ */
  // Factual first-level divisions for the countries we list. Anything not
  // covered falls back to a free-text state field rather than guessing.
  const COUNTRY_STATES = {
    india: [
      "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat",
      "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
      "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab",
      "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh",
      "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
      "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh",
      "Lakshadweep", "Puducherry",
    ],
    "united-states": [
      "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
      "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
      "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
      "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
      "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
      "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
      "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
      "Wisconsin", "Wyoming",
    ],
    "united-kingdom": ["England", "Scotland", "Wales", "Northern Ireland"],
    uae: [
      "Abu Dhabi", "Ajman", "Dubai", "Fujairah", "Ras Al Khaimah", "Sharjah", "Umm Al Quwain",
    ],
    singapore: ["Singapore"],
  };

  const COUNTRIES = [
    { value: "india", label: "India" },
    { value: "united-states", label: "United States" },
    { value: "united-kingdom", label: "United Kingdom" },
    { value: "uae", label: "United Arab Emirates" },
    { value: "singapore", label: "Singapore" },
    { value: "other", label: "Other country" },
  ];

  const RADIUS_OPTIONS = [
    "Within 2 km", "Within 5 km", "Within 10 km", "Within 15 km", "Within 25 km",
    "Within 50 km", "No limit",
  ];

  let locationSubmitting = false;

  function fillSelect(select, items, placeholder) {
    select.innerHTML = "";
    if (placeholder != null) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = placeholder;
      select.appendChild(o);
    }
    items.forEach(function (item) {
      const o = document.createElement("option");
      o.value = typeof item === "string" ? item : item.value;
      o.textContent = typeof item === "string" ? item : item.label;
      select.appendChild(o);
    });
  }

  // Country drives the state list; countries without a list fall back to text.
  function populateStates() {
    const list = COUNTRY_STATES[locCountry.value];
    if (!list) {
      locStateControl.hidden = true;
      locStateTextControl.hidden = false;
      fillSelect(locState, [], null);
      // Keep the label attached to whichever control is actually shown.
      locStateLabel.setAttribute("for", "loc-state-text");
      return;
    }
    locStateControl.hidden = false;
    locStateTextControl.hidden = true;
    locStateLabel.setAttribute("for", "loc-state");
    fillSelect(locState, list, "Select a state or region");
    locState.value = "";
  }

  function populateCountries() {
    fillSelect(locCountry, COUNTRIES, null);
    locCountry.value = "india";
    populateStates();
  }

  /* ---------------------------- mode ----------------------------------- */
  function selectedMode() {
    const checked = modeList.querySelector("[data-mode]:checked");
    return checked ? checked.value : "";
  }
  function isOnlineMode() {
    const m = selectedMode();
    return m === "online" || m === "both";
  }
  function isInPersonMode() {
    const m = selectedMode();
    return m === "in-person" || m === "both";
  }

  function syncModeCards() {
    modeList.querySelectorAll(".mode-card").forEach(function (card) {
      const input = card.querySelector("input");
      card.classList.toggle("is-checked", !!(input && input.checked));
    });
  }

  // Show only the fields that matter for the chosen mode. Hidden fields keep
  // whatever the teacher already typed — nothing is cleared.
  function updateConditionalFields() {
    onlineSection.hidden = !isOnlineMode();
    locAreaField.hidden = !isInPersonMode();
    locRadiusField.hidden = !isInPersonMode();
    if (!isInPersonMode()) setFieldError("loc-area", "");
  }

  modeList.addEventListener("change", function () {
    syncModeCards();
    updateConditionalFields();
    setFieldError("location-mode", "");
  });

  locCountry.addEventListener("change", function () {
    populateStates();
    setFieldError("loc-state", "");
  });

  /* -------------------------- validation -------------------------------- */
  function validateMode() {
    return selectedMode() ? "" : "Select at least one teaching mode.";
  }
  function validateCountry() {
    return locCountry.value ? "" : "Country is required.";
  }
  function validateState() {
    if (!locStateTextControl.hidden) {
      return locStateText.value.trim() ? "" : "State or region is required.";
    }
    return locState.value ? "" : "Select a state or region.";
  }
  function validateCity() {
    return locCity.value.trim() ? "" : "City is required.";
  }
  function validateArea() {
    if (!isInPersonMode()) return "";
    return locArea.value.trim() ? "" : "Area or locality is required for in-person teaching.";
  }

  locState.addEventListener("change", function () {
    if (locState.value) setFieldError("loc-state", "");
  });
  locStateText.addEventListener("input", function () {
    if (locStateText.value.trim()) setFieldError("loc-state", "");
  });
  locCity.addEventListener("input", function () {
    if (locCity.value.trim()) setFieldError("loc-city", "");
  });
  locArea.addEventListener("input", function () {
    if (locArea.value.trim()) setFieldError("loc-area", "");
  });

  function clearLocationErrors() {
    LOCATION_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
  }

  function setLocationLoading(isLoading) {
    locationContinue.classList.toggle("is-loading", isLoading);
    locationContinue.setAttribute("aria-busy", String(isLoading));
    locationContinue.disabled = isLoading;
    locationContinue.querySelector(".btn__label").textContent = isLoading ? "Saving…" : "Continue";
  }

  locationForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (locationSubmitting) return; // ignore duplicate submissions

    const checks = [
      ["location-mode", validateMode(), modeList],
      ["loc-country", validateCountry(), locCountry],
      ["loc-state", validateState(), locStateTextControl.hidden ? locState : locStateText],
      ["loc-city", validateCity(), locCity],
      ["loc-area", validateArea(), locArea],
    ];

    let firstInvalid = null;
    checks.forEach(function (item) {
      setFieldError(item[0], item[1]);
      if (item[1] && !firstInvalid) firstInvalid = item[2];
    });

    if (firstInvalid) {
      const target = firstInvalid.matches && firstInvalid.matches("input, select")
        ? firstInvalid
        : firstInvalid.querySelector("input, select");
      if (target) target.focus({ preventScroll: true });
      else window.scrollTo(0, 0);
      return;
    }

    locationSubmitting = true;
    setLocationLoading(true);
    saveTeacherSection("location")
      .then(function () {
        locationForm.hidden = true;
        locationSuccess.hidden = false;
        locationSuccess.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      })
      .catch(function (error) {
        showTeacherApiError(error, TEACHER_SECTION_FIELDS.location);
      })
      .finally(function () {
        setLocationLoading(false);
        locationSubmitting = false;
      });
  });

  // Prototype-only continuation from the subjects notice.
  continueToLocation.addEventListener("click", function () {
    navigate("location");
  });

  locationBack.addEventListener("click", function () {
    navigate("subjects");
  });

  locationEdit.addEventListener("click", function () {
    locationSuccess.hidden = true;
    locationForm.hidden = false;
    const first = modeList.querySelector("input");
    if (first) first.focus({ preventScroll: true });
  });

  locationDone.addEventListener("click", function () {
    locationSuccess.hidden = true;
    locationForm.hidden = false;
    navigate("login");
  });

  /* ============ Teaching availability (, Part 5) ================= */
  const DAYS = [
    { id: "mon", label: "Monday" },
    { id: "tue", label: "Tuesday" },
    { id: "wed", label: "Wednesday" },
    { id: "thu", label: "Thursday" },
    { id: "fri", label: "Friday" },
    { id: "sat", label: "Saturday" },
    { id: "sun", label: "Sunday" },
  ];

  const DAY_LOOKUP = {};
  DAYS.forEach(function (day) {
    DAY_LOOKUP[day.id] = day;
  });

  // Slots are kept per day even when a day is unchecked, so a teacher who
  // toggles a day off by mistake gets their times back when they re-check it.
  const availabilitySlots = {};
  const availableDayIds = new Set();
  DAYS.forEach(function (day) {
    availabilitySlots[day.id] = [];
  });

  let availabilitySubmitting = false;

  function selectedDayObjects() {
    return DAYS.filter(function (day) {
      return availableDayIds.has(day.id);
    });
  }

  function timeToMinutes(value) {
    if (!value || value.indexOf(":") === -1) return null;
    const parts = value.split(":");
    if (parts.length !== 2) return null;
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    if (!isFinite(hours) || !isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function formatTime(value) {
    const total = timeToMinutes(value);
    if (total === null) return value || "";
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    const period = hours >= 12 ? "PM" : "AM";
    const hours12 = hours % 12 || 12;
    return hours12 + ":" + String(minutes).padStart(2, "0") + " " + period;
  }

  function slotTimeLabel(slot) {
    return formatTime(slot.start) + " \u2013 " + formatTime(slot.end);
  }

  function buildTimeField(labelText, id, value, errorId) {
    const field = document.createElement("div");
    field.className = "field";

    const label = document.createElement("label");
    label.className = "field__label";
    label.setAttribute("for", id);
    label.textContent = labelText;

    const control = document.createElement("div");
    control.className = "field__control";

    const icon = document.createElement("span");
    icon.className = "field__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg width="17" height="17" aria-hidden="true"><use href="#i-clock" /></svg>';

    const input = document.createElement("input");
    input.type = "time";
    input.id = id;
    input.value = value || "";
    input.step = "900"; // 15-minute increments
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-describedby", errorId);

    control.appendChild(icon);
    control.appendChild(input);
    field.appendChild(label);
    field.appendChild(control);
    return field;
  }

  function setSlotError(row, message) {
    if (!row) return;
    const error = row.querySelector("[data-slot-error]");
    if (message) {
      row.classList.add("has-error");
      if (error) {
        error.textContent = message;
        error.hidden = false;
      }
    } else {
      row.classList.remove("has-error");
      if (error) {
        error.textContent = "";
        error.hidden = true;
      }
    }
  }

  function clearSlotError(row) {
    setSlotError(row, "");
  }

  function buildSlotRow(day, index, slot) {
    const row = document.createElement("div");
    row.className = "avail-slot";
    row.setAttribute("data-slot-index", String(index));

    const startId = "avail-" + day.id + "-" + index + "-start";
    const endId = "avail-" + day.id + "-" + index + "-end";
    const errorId = "avail-" + day.id + "-" + index + "-error";

    const startField = buildTimeField("Start time", startId, slot.start, errorId);
    const endField = buildTimeField("End time", endId, slot.end, errorId);

    const sep = document.createElement("span");
    sep.className = "avail-slot__sep";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "to";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--danger-subtle avail-slot__remove";
    remove.innerHTML = '<svg width="15" height="15" aria-hidden="true"><use href="#i-trash" /></svg><span>Delete</span>';
    remove.setAttribute("aria-label", "Delete time slot " + (index + 1) + " for " + day.label);
    remove.setAttribute("title", "Delete time slot " + (index + 1) + " for " + day.label);
    remove.addEventListener("click", function () {
      removeAvailabilitySlot(day.id, index);
    });

    const error = document.createElement("p");
    error.className = "field__error avail-slot__error";
    error.id = errorId;
    error.setAttribute("role", "alert");
    error.setAttribute("data-slot-error", "");
    error.hidden = true;

    const startInput = startField.querySelector("input");
    const endInput = endField.querySelector("input");

    startInput.addEventListener("input", function () {
      availabilitySlots[day.id][index].start = startInput.value;
      clearSlotError(row);
    });
    startInput.addEventListener("change", function () {
      availabilitySlots[day.id][index].start = startInput.value;
      validateDaySlots(day.id);
    });
    endInput.addEventListener("input", function () {
      availabilitySlots[day.id][index].end = endInput.value;
      clearSlotError(row);
    });
    endInput.addEventListener("change", function () {
      availabilitySlots[day.id][index].end = endInput.value;
      validateDaySlots(day.id);
    });

    row.appendChild(startField);
    row.appendChild(sep);
    row.appendChild(endField);
    row.appendChild(remove);
    row.appendChild(error);
    return row;
  }

  function renderAvailabilityDays() {
    availabilityDayList.innerHTML = "";
    const days = selectedDayObjects();
    availabilityEmpty.hidden = days.length > 0;

    days.forEach(function (day) {
      const slots = availabilitySlots[day.id];
      const panel = document.createElement("section");
      panel.className = "avail-day";
      panel.setAttribute("data-day-panel", day.id);
      panel.setAttribute("aria-labelledby", "avail-day-" + day.id);

      const head = document.createElement("div");
      head.className = "avail-day__head";

      const title = document.createElement("p");
      title.className = "avail-day__title";
      title.id = "avail-day-" + day.id;
      title.textContent = day.label;

      const count = document.createElement("span");
      count.className = "avail-day__count";
      count.textContent = slots.length + (slots.length === 1 ? " time slot" : " time slots");

      head.appendChild(title);
      head.appendChild(count);
      panel.appendChild(head);

      if (slots.length === 0) {
        const empty = document.createElement("div");
        empty.className = "avail-empty avail-empty--inline";

        const emptyMsg = document.createElement("p");
        emptyMsg.className = "avail-empty__text";
        emptyMsg.textContent = "No time slots added for " + day.label + ".";
        empty.appendChild(emptyMsg);

        const actions = document.createElement("div");
        actions.className = "avail-empty__actions";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "btn btn--ghost btn--sm avail-empty__add-btn";
        addBtn.innerHTML =
          '<svg width="14" height="14" aria-hidden="true"><use href="#i-plus" /></svg>' +
          '<span>Add time slot</span>';
        addBtn.addEventListener("click", function () {
          addAvailabilitySlot(day.id);
        });
        actions.appendChild(addBtn);

        const removeDayBtn = document.createElement("button");
        removeDayBtn.type = "button";
        removeDayBtn.className = "btn btn--ghost btn--sm btn--danger-text avail-empty__remove-day";
        removeDayBtn.innerHTML =
          '<svg width="14" height="14" aria-hidden="true"><use href="#i-close" /></svg>' +
          '<span>Remove ' + day.label + '</span>';
        removeDayBtn.addEventListener("click", function () {
          removeDayFromAvailability(day.id);
        });
        actions.appendChild(removeDayBtn);

        empty.appendChild(actions);
        panel.appendChild(empty);
      } else {
        const wrap = document.createElement("div");
        wrap.className = "avail-slots";
        slots.forEach(function (slot, index) {
          wrap.appendChild(buildSlotRow(day, index, slot));
        });
        panel.appendChild(wrap);

        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn btn--ghost btn--add avail-day__add";
        add.setAttribute("data-day-add", day.id);
        add.innerHTML =
          '<svg width="16" height="16" aria-hidden="true"><use href="#i-plus" /></svg>' +
          '<span class="btn__label">Add time slot</span>';
        add.addEventListener("click", function () {
          addAvailabilitySlot(day.id);
        });
        panel.appendChild(add);
      }

      const dayError = document.createElement("p");
      dayError.className = "field__error avail-day__error";
      dayError.setAttribute("data-day-error", day.id);
      dayError.setAttribute("role", "alert");
      dayError.hidden = true;
      panel.appendChild(dayError);

      availabilityDayList.appendChild(panel);
    });
  }

  function addAvailabilitySlot(dayId) {
    const slots = availabilitySlots[dayId];
    if (!slots) return;
    slots.push({ start: "", end: "" });
    clearAvailabilityErrors();
    renderAvailabilityDays();
    const newIndex = slots.length - 1;
    const input = availabilityDayList.querySelector(
      '[data-day-panel="' + dayId + '"] [data-slot-index="' + newIndex + '"] input[type="time"]'
    );
    if (input) input.focus({ preventScroll: true });
  }

  function removeAvailabilitySlot(dayId, index) {
    const slots = availabilitySlots[dayId];
    if (!slots || !slots[index]) return;
    slots.splice(index, 1);
    clearAvailabilityErrors();
    renderAvailabilityDays();
    const add = availabilityDayList.querySelector('[data-day-panel="' + dayId + '"] [data-day-add]');
    if (add) add.focus({ preventScroll: true });
  }

  function removeDayFromAvailability(dayId) {
    availableDayIds.delete(dayId);
    if (dayGrid) {
      const cb = dayGrid.querySelector('input[data-day="' + dayId + '"]');
      if (cb) cb.checked = false;
    }
    clearAvailabilityErrors();
    renderAvailabilityDays();
    syncCheckStates();
  }

  function clearAvailabilityErrors() {
    AVAILABILITY_FIELDS.forEach(function (name) {
      setFieldError(name, "");
    });
    if (!availabilityDayList) return;
    availabilityDayList.querySelectorAll(".avail-slot").forEach(function (row) {
      clearSlotError(row);
    });
    availabilityDayList.querySelectorAll("[data-day-error]").forEach(function (error) {
      error.textContent = "";
      error.hidden = true;
    });
  }

  // Validate every slot for one day. Overlap is symmetric, so both conflicting
  // slots are marked rather than making the teacher guess which one to change.
  function validateDaySlots(dayId) {
    const slots = availabilitySlots[dayId] || [];
    const panel = availabilityDayList.querySelector('[data-day-panel="' + dayId + '"]');
    const day = DAY_LOOKUP[dayId];
    const dayError = panel ? panel.querySelector("[data-day-error]") : null;
    let ok = true;
    let firstInvalid = null;
    const errors = [];

    if (dayError) {
      dayError.textContent = "";
      dayError.hidden = true;
    }

    if (!slots.length) {
      if (dayError && day) {
        dayError.textContent = "Add at least one time slot for " + day.label + ".";
        dayError.hidden = false;
      }
      errors.push({
        message: day ? "Add at least one time slot for " + day.label + "." : "Add at least one time slot.",
      });
      const add = panel ? panel.querySelector("[data-day-add]") : null;
      return { ok: false, firstInvalid: add || null, errors: errors };
    }

    slots.forEach(function (slot, index) {
      const row = panel ? panel.querySelector('[data-slot-index="' + index + '"]') : null;
      const start = timeToMinutes(slot.start);
      const end = timeToMinutes(slot.end);
      let message = "";

      if (!slot.start || !slot.end) {
        message = "Add both a start and end time.";
      } else if (start === null || end === null) {
        message = "Enter a valid start and end time.";
      } else if (start >= end) {
        message = "End time must be later than the start time.";
      } else {
        for (let other = 0; other < slots.length; other += 1) {
          if (other === index) continue;
          const otherSlot = slots[other];
          const otherStart = timeToMinutes(otherSlot.start);
          const otherEnd = timeToMinutes(otherSlot.end);
          if (otherStart === null || otherEnd === null || otherStart >= otherEnd) continue;

          if (slot.start === otherSlot.start && slot.end === otherSlot.end) {
            message = "This time slot duplicates " + formatTime(otherSlot.start) + " \u2013 " +
              formatTime(otherSlot.end) + ".";
            break;
          }
          if (start < otherEnd && otherStart < end) {
            message = "This time slot overlaps " + formatTime(otherSlot.start) + " \u2013 " +
              formatTime(otherSlot.end) + ".";
            break;
          }
        }
      }

      setSlotError(row, message);
      if (message) {
        ok = false;
        errors.push({
          message:
            (day ? day.label + ", time slot " + (index + 1) + ": " : "Time slot " + (index + 1) + ": ") +
            message,
        });
        if (!firstInvalid) {
          firstInvalid = row ? row.querySelector("input") : panel ? panel.querySelector("[data-day-add]") : null;
        }
      }
    });

    return { ok: ok, firstInvalid: firstInvalid, errors: errors };
  }

  function validateAvailability() {
    let ok = true;
    let firstInvalid = null;
    const issues = [];

    setFieldError("availability-days", "");
    // A teacher may take down every teaching day: that is how a teacher takes
    // a break without giving up the profile. The server then refuses new
    // lesson requests, and the bookings that are already on record stay as
    // they are. A day that is ticked still needs hours of its own.
    selectedDayObjects().forEach(function (day) {
      const result = validateDaySlots(day.id);
      if (!result.ok) {
        ok = false;
        if (!firstInvalid) firstInvalid = result.firstInvalid;
        result.errors.forEach(function (error) {
          issues.push(error.message);
        });
      }
    });

    return { ok: ok, firstInvalid: firstInvalid, issues: issues };
  }

  function setAvailabilityLoading(isLoading) {
    availabilityContinue.classList.toggle("is-loading", isLoading);
    availabilityContinue.setAttribute("aria-busy", String(isLoading));
    availabilityContinue.disabled = isLoading;
    availabilityContinue.querySelector(".btn__label").textContent = isLoading ? "Reviewing…" : "Continue";
  }

  dayGrid.addEventListener("change", function (event) {
    const input = event.target;
    if (!input || input.type !== "checkbox") return;
    const dayId = input.getAttribute("data-day");
    if (!dayId) return;

    if (input.checked) {
      availableDayIds.add(dayId);
      if (!availabilitySlots[dayId].length) {
        availabilitySlots[dayId].push({ start: "", end: "" });
      }
    } else {
      availableDayIds.delete(dayId);
    }

    setFieldError("availability-days", "");
    clearAvailabilityErrors();
    renderAvailabilityDays();
    syncCheckStates();
  });

  availabilityForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (availabilitySubmitting) return; // ignore duplicate submissions

    const result = validateAvailability();
    if (!result.ok) {
      if (result.firstInvalid) result.firstInvalid.focus({ preventScroll: true });
      return;
    }

    availabilitySubmitting = true;
    setAvailabilityLoading(true);
    saveTeacherSection("availability")
      .then(function () {
        navigate("review");
      })
      .catch(function (error) {
        showTeacherApiError(error, TEACHER_SECTION_FIELDS.availability);
      })
      .finally(function () {
        setAvailabilityLoading(false);
        availabilitySubmitting = false;
      });
  });

  continueToAvailability.addEventListener("click", function () {
    navigate("availability");
  });

  availabilityBack.addEventListener("click", function () {
    openSectionForEdit("location");
  });

  /* ================== Profile review & finish (, Part 5) ========= */
  const REVIEW_SECTION_TITLES = {
    basics: "Basics",
    qualifications: "Qualifications & experience",
    subjects: "Subjects & classes",
    location: "Location & teaching mode",
    availability: "Availability",
  };

  const MODE_LABELS = {
    online: "Online",
    "in-person": "In-person",
    both: "Online & in-person",
  };

  function selectedOptionText(select) {
    if (!select || select.selectedIndex < 0) return "";
    const option = select.options[select.selectedIndex];
    return option ? option.textContent.trim() : "";
  }

  function addReviewRow(body, label, value) {
    const row = document.createElement("div");
    row.className = "review-row";

    const labelEl = document.createElement("p");
    labelEl.className = "review-row__label";
    labelEl.textContent = label;

    // A div (not a p): some values are rich nodes (tag lists, qualification
    // items) and a <p> may not legally contain block-level children.
    const valueEl = document.createElement("div");
    valueEl.className = "review-row__value";
    if (value instanceof Node) {
      valueEl.appendChild(value);
    } else {
      valueEl.textContent = value || "Not provided";
    }

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    body.appendChild(row);
  }

  function reviewTagList(labels, fallback) {
    const list = document.createElement("div");
    list.className = "review-tags";
    if (!labels.length) {
      const empty = document.createElement("span");
      empty.className = "review-row__value";
      empty.textContent = fallback || "Not provided";
      list.appendChild(empty);
      return list;
    }
    labels.forEach(function (label) {
      const tag = document.createElement("span");
      tag.className = "review-tag";
      tag.textContent = label;
      list.appendChild(tag);
    });
    return list;
  }

  // The review builders are shared by the setup review screen and the
  // dashboard's My Profile overview; this points them at the right list.
  let reviewTarget = reviewList;

  function makeReviewCard(key, title, editView, onEdit) {
    const card = document.createElement("section");
    card.className = "review-card";
    card.setAttribute("data-review-section", key);

    const head = document.createElement("div");
    head.className = "review-card__head";

    const heading = document.createElement("h3");
    heading.className = "review-card__title";
    heading.textContent = title;

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "review-edit";
    edit.setAttribute("aria-label", "Edit " + title);
    edit.innerHTML =
      '<svg width="14" height="14" aria-hidden="true"><use href="#i-edit" /></svg><span>Edit</span>';
    edit.addEventListener("click", function () {
      if (typeof onEdit === "function") onEdit();
      else openSectionForEdit(editView);
    });

    head.appendChild(heading);
    head.appendChild(edit);

    const body = document.createElement("div");
    body.className = "review-card__body";

    card.appendChild(head);
    card.appendChild(body);
    reviewTarget.appendChild(card);
    return body;
  }

  function buildBasicsReview(onEdit) {
    const body = makeReviewCard("basics", REVIEW_SECTION_TITLES.basics, "profile", onEdit);

    const identity = document.createElement("div");
    identity.className = "review-identity";

    const photo = document.createElement("div");
    photo.className = "review-photo";
    if (photoObjectUrl) {
      const img = document.createElement("img");
      img.src = photoObjectUrl;
      img.alt = pName.value.trim() ? "Profile photo of " + pName.value.trim() : "Profile photo";
      photo.appendChild(img);
    } else {
      photo.innerHTML = '<svg width="26" height="26" aria-hidden="true"><use href="#i-user" /></svg>';
    }

    const identityText = document.createElement("div");
    const name = document.createElement("p");
    name.className = "review-identity__name";
    name.textContent = pName.value.trim() || "Full name not provided";
    const email = document.createElement("p");
    email.className = "review-identity__email";
    email.textContent = pEmail.value.trim() || "Contact email not provided";
    identityText.appendChild(name);
    identityText.appendChild(email);

    const docVerificationEnabled = platformSettings && platformSettings.general && platformSettings.general.requireTeacherDocumentVerification !== false;
    if (docVerificationEnabled && teacherListing.documentsVerified) {
      const vBadge = document.createElement("div");
      vBadge.className = "verified-chip";
      vBadge.style.cssText = "display:inline-flex; align-items:center; gap:6px; margin-top:6px; background:rgba(16,185,129,0.12); color:#059669; padding:4px 10px; border-radius:999px; font-size:0.8rem; font-weight:600;";
      vBadge.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg> Documents &amp; Results Verified';
      identityText.appendChild(vBadge);
    }

    identity.appendChild(photo);
    identity.appendChild(identityText);
    body.appendChild(identity);

    addReviewRow(body, "Bio", pBio.value.trim() || "Not provided");
    addReviewRow(body, "Profile photo", photoObjectUrl ? "Added" : "Not added (optional)");
  }

  function buildQualificationsReview(onEdit) {
    const body = makeReviewCard(
      "qualifications",
      REVIEW_SECTION_TITLES.qualifications,
      "qualifications",
      onEdit
    );

    const qualificationWrap = document.createElement("div");
    let count = 0;

    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      const values = {};
      row.querySelectorAll("[data-qual-input]").forEach(function (input) {
        values[input.getAttribute("data-qual-input")] = input.value.trim();
      });
      if (!values.name && !values.institution && !values.year) return;

      const item = document.createElement("div");
      item.className = "review-item";

      const title = document.createElement("p");
      title.className = "review-item__title";
      title.textContent = values.name || "Qualification not named";

      const meta = document.createElement("p");
      meta.className = "review-item__meta";
      meta.textContent = [values.institution, values.year].filter(Boolean).join(" \u00b7 ") ||
        "Institution or year not provided";

      item.appendChild(title);
      item.appendChild(meta);
      qualificationWrap.appendChild(item);
      count += 1;
    });

    if (count === 0) {
      const empty = document.createElement("p");
      empty.className = "review-row__value";
      empty.textContent = "Not provided";
      qualificationWrap.appendChild(empty);
    }

    addReviewRow(body, "Qualifications", qualificationWrap);

    addReviewRow(body, "Experience level", expLevel.value ? selectedOptionText(expLevel) : "Not provided");

    const years = expYears.value.trim();
    addReviewRow(
      body,
      "Total teaching experience",
      years ? years + (Number(years) === 1 ? " year" : " years") : "Not provided"
    );

    if (expOrg.value.trim()) {
      addReviewRow(body, "Previous institution", expOrg.value.trim());
    }
    if (expDesc.value.trim()) {
      addReviewRow(body, "Experience summary", expDesc.value.trim());
    }
  }

  function checkedLabels(grid, dataAttribute, options) {
    const labels = [];
    grid.querySelectorAll("[" + dataAttribute + "]:checked").forEach(function (input) {
      const value = input.getAttribute(dataAttribute);
      const found = options.filter(function (option) {
        return option.id === value;
      })[0];
      if (found) labels.push(found.label);
    });
    return labels;
  }

  function buildSubjectsReview(onEdit) {
    const body = makeReviewCard("subjects", REVIEW_SECTION_TITLES.subjects, "subjects", onEdit);

    const subjects = selectedSubjects().map(function (subject) {
      return subject.label;
    });
    addReviewRow(body, "Subjects taught", reviewTagList(subjects, "No subjects selected"));

    const grades = checkedLabels(gradeGrid, "data-grade", GRADE_OPTIONS);
    addReviewRow(
      body,
      "Grades & classes",
      reviewTagList(grades, "No grades or classes selected")
    );

    const streams = checkedLabels(streamGrid, "data-stream", STREAM_OPTIONS);
    if (streams.length) {
      addReviewRow(body, "Stream (Classes 11\u201312)", reviewTagList(streams));
    }

    const other = gradeGrid.querySelector('[data-grade="other"]');
    if (other && other.checked && otherLevel.value.trim()) {
      addReviewRow(body, "Other level", otherLevel.value.trim());
    }
  }

  function buildLocationReview(onEdit) {
    const body = makeReviewCard("location", REVIEW_SECTION_TITLES.location, "location", onEdit);

    const mode = selectedMode();
    addReviewRow(body, "Teaching mode", MODE_LABELS[mode] || "Not provided");

    const country = selectedOptionText(locCountry);
    const state = locStateTextControl.hidden ? locState.value : locStateText.value.trim();
    const city = locCity.value.trim();
    const location = [city, state, country].filter(Boolean).join(", ");
    addReviewRow(body, "Location", location || "Not provided");

    if (isInPersonMode()) {
      if (locArea.value.trim()) addReviewRow(body, "Area or locality", locArea.value.trim());
      addReviewRow(body, "Travel radius", locRadius.value || "Not provided");
    }

    if (isOnlineMode() && locOnlineTools.value.trim()) {
      addReviewRow(body, "Online tools", locOnlineTools.value.trim());
    }
  }

  function buildAvailabilityReview(onEdit) {
    const body = makeReviewCard(
      "availability",
      REVIEW_SECTION_TITLES.availability,
      "availability",
      onEdit
    );

    const days = selectedDayObjects();
    if (!days.length) {
      addReviewRow(body, "Available days & times", "Not provided");
      return;
    }

    // Weekly overview ribbon showing all 7 days with active color bubbles
    const weekStrip = document.createElement("div");
    weekStrip.className = "avail-week-strip";
    weekStrip.setAttribute("aria-label", "Weekly teaching days summary");
    DAYS.forEach(function (day) {
      const isActive = availableDayIds.has(day.id);
      const pill = document.createElement("span");
      pill.className = "avail-week-pill " + (isActive ? "is-active" : "is-off");
      pill.setAttribute("title", day.label + ": " + (isActive ? "Active teaching day" : "Day off"));
      pill.innerHTML =
        '<span class="avail-week-pill__dot" aria-hidden="true"></span>' +
        '<span class="avail-week-pill__name">' + day.label.slice(0, 3) + '</span>' +
        '<span class="avail-week-pill__status">' + (isActive ? "Active" : "Off") + '</span>';
      weekStrip.appendChild(pill);
    });
    body.appendChild(weekStrip);

    // Schedule grid of spacious day boxes with color bubbles and time bubbles
    const grid = document.createElement("div");
    grid.className = "avail-boxes-grid";

    days.forEach(function (day) {
      const slots = availabilitySlots[day.id].slice().sort(function (a, b) {
        const aStart = timeToMinutes(a.start);
        const bStart = timeToMinutes(b.start);
        return (aStart === null ? 0 : aStart) - (bStart === null ? 0 : bStart);
      });

      const complete = slots.filter(function (slot) {
        return timeToMinutes(slot.start) !== null && timeToMinutes(slot.end) !== null;
      });

      const box = document.createElement("div");
      box.className = "avail-day-box";

      const head = document.createElement("div");
      head.className = "avail-day-box__head";

      const badge = document.createElement("span");
      badge.className = "avail-day-badge";
      badge.innerHTML =
        '<svg width="14" height="14" aria-hidden="true"><use href="#i-calendar" /></svg>' +
        '<span>' + day.label + '</span>';

      const count = document.createElement("span");
      count.className = "avail-slot-pill";
      count.textContent = complete.length + (complete.length === 1 ? " time slot" : " time slots");

      head.appendChild(badge);
      head.appendChild(count);
      box.appendChild(head);

      const slotsWrap = document.createElement("div");
      slotsWrap.className = "avail-day-box__slots";

      if (complete.length) {
        complete.forEach(function (slot) {
          const bubble = document.createElement("span");
          bubble.className = "avail-time-bubble";
          bubble.innerHTML =
            '<svg width="13" height="13" aria-hidden="true"><use href="#i-clock" /></svg>' +
            '<span>' + slotTimeLabel(slot) + '</span>';
          slotsWrap.appendChild(bubble);
        });
      } else {
        const empty = document.createElement("span");
        empty.className = "avail-time-empty";
        empty.textContent = "No time slots set";
        slotsWrap.appendChild(empty);
      }

      box.appendChild(slotsWrap);
      grid.appendChild(box);
    });

    body.appendChild(grid);
  }

  function renderReview() {
    reviewTarget = reviewList;
    reviewList.innerHTML = "";
    reviewAlert.hidden = true;
    reviewAlertList.innerHTML = "";
    reviewContent.hidden = false;
    reviewComplete.hidden = true;

    buildBasicsReview();
    buildQualificationsReview();
    buildSubjectsReview();
    buildLocationReview();
    buildAvailabilityReview();
  }

  function clearReviewFeedback() {
    if (!reviewAlert) return;
    reviewAlert.hidden = true;
    if (reviewAlertList) reviewAlertList.innerHTML = "";
    if (!reviewList) return;
    reviewList.querySelectorAll(".review-card.is-incomplete").forEach(function (card) {
      card.classList.remove("is-incomplete");
    });
  }

  function showReviewIssues(issues) {
    reviewAlertList.innerHTML = "";
    reviewList.querySelectorAll(".review-card.is-incomplete").forEach(function (card) {
      card.classList.remove("is-incomplete");
    });

    issues.forEach(function (issue) {
      const item = document.createElement("li");
      item.textContent = issue.message;
      reviewAlertList.appendChild(item);

      const card = reviewList.querySelector('[data-review-section="' + issue.key + '"]');
      if (card) card.classList.add("is-incomplete");
    });

    reviewAlert.hidden = false;
    reviewAlert.focus({ preventScroll: true });
    reviewAlert.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Run every section's rules before finishing. Inline errors are set inside
  // each section too, so an Edit click lands on a form that explains itself.
  function validateAllProfileSections() {
    const issues = [];

    const nameMessage = validateProfileName();
    const bioMessage = validateProfileBio();
    const emailMessage = validateProfileEmail();
    setFieldError("profile-name", nameMessage);
    setFieldError("profile-bio", bioMessage);
    setFieldError("profile-email", emailMessage);
    if (nameMessage || bioMessage || emailMessage) {
      issues.push({
        key: "basics",
        message: "Basics: add your full name, contact email and a short bio.",
      });
    }

    let qualificationInvalid = false;
    if (!qualList.querySelector("[data-qual]")) {
      addQualificationRow();
      qualificationInvalid = true;
    }
    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      if (validateQualRow(row)) qualificationInvalid = true;
    });

    const levelMessage = validateExpLevel();
    const yearsMessage = validateExpYears();
    setFieldError("qual-exp-level", levelMessage);
    setFieldError("qual-exp-years", yearsMessage);
    if (qualificationInvalid || levelMessage || yearsMessage) {
      issues.push({
        key: "qualifications",
        message: "Qualifications & experience: complete every required qualification, level and years field.",
      });
    }

    const subjectMessage = validateSubjects();
    const gradeMessage = validateGrades();
    const streamMessage = validateStreams();
    const otherLevelMessage = validateOtherLevel();
    setFieldError("subjects", subjectMessage);
    setFieldError("grades", gradeMessage);
    setFieldError("subject-stream", streamMessage);
    setFieldError("subject-grade-other", otherLevelMessage);
    if (subjectMessage || gradeMessage || streamMessage || otherLevelMessage) {
      issues.push({
        key: "subjects",
        message: "Subjects & classes: choose at least one subject and one class, and complete any shown details.",
      });
    }

    const modeMessage = validateMode();
    const countryMessage = validateCountry();
    const stateMessage = validateState();
    const cityMessage = validateCity();
    const areaMessage = validateArea();
    setFieldError("location-mode", modeMessage);
    setFieldError("loc-country", countryMessage);
    setFieldError("loc-state", stateMessage);
    setFieldError("loc-city", cityMessage);
    setFieldError("loc-area", areaMessage);
    if (modeMessage || countryMessage || stateMessage || cityMessage || areaMessage) {
      issues.push({
        key: "location",
        message: "Location & teaching mode: complete your mode, country, state/region and city.",
      });
    }

    const availabilityResult = validateAvailability();
    if (!availabilityResult.ok) {
      issues.push({
        key: "availability",
        message: "Availability: pick at least one day and add valid, non-overlapping time slots for it.",
      });
    }

    return issues;
  }

  function openSectionForEdit(name) {
    if (name === "profile") {
      profileSuccess.hidden = true;
      profileForm.hidden = false;
    } else if (name === "qualifications") {
      qualSuccess.hidden = true;
      qualForm.hidden = false;
    } else if (name === "subjects") {
      subjectsSuccess.hidden = true;
      subjectsForm.hidden = false;
    } else if (name === "location") {
      locationSuccess.hidden = true;
      locationForm.hidden = false;
    }

    navigate(name);

    // renderView focuses the heading; after that, put the caret on the first
    // meaningful control so editing is immediate.
    window.setTimeout(function () {
      let target = null;
      if (name === "profile") target = pName;
      else if (name === "qualifications") target = qualList.querySelector("[data-qual-input]");
      else if (name === "subjects") target = subjectGrid.querySelector("input");
      else if (name === "location") target = modeList.querySelector("input");
      else if (name === "availability") target = dayGrid.querySelector("input");
      if (target) target.focus({ preventScroll: true });
    }, 0);
  }

  let finishSubmitting = false;

  finishProfile.addEventListener("click", function () {
    if (finishSubmitting) return;
    const issues = validateAllProfileSections();
    if (issues.length) {
      showReviewIssues(issues);
      return;
    }

    finishSubmitting = true;
    finishProfile.classList.add("is-loading");
    finishProfile.setAttribute("aria-busy", "true");
    finishProfile.disabled = true;
    uploadTeacherPhotoIfChosen()
      .then(function () {
        return persistTeacherSection(Object.assign(teacherFullPayload(), { completed: true }));
      })
      .then(function () {
        reviewAlert.hidden = true;
        reviewContent.hidden = true;
        reviewComplete.hidden = false;
        reviewComplete.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      })
      .catch(function (error) {
        showTeacherApiError(error, {});
      })
      .finally(function () {
        finishSubmitting = false;
        finishProfile.classList.remove("is-loading");
        finishProfile.removeAttribute("aria-busy");
        finishProfile.disabled = false;
      });
  });

  reviewBack.addEventListener("click", function () {
    navigate("availability");
  });

  reviewAgain.addEventListener("click", function () {
    reviewComplete.hidden = true;
    reviewContent.hidden = false;
    renderReview();
    const heading = document.getElementById("review-title");
    if (heading) heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });

  reviewLogin.addEventListener("click", function () {
    navigate("login");
  });

  /* ============ Teacher dashboard (, Part 1) ===================== */
  // The dashboard is a view like any other, so Back/Forward and direct links
  // keep working. It reads the SAME in-memory values gathered during profile
  // setup (never re-fetched, never stored) and reuses the existing profile,
  // subjects and availability screens rather than duplicating them.
  const dashboardView = document.getElementById("view-dashboard");
  const authShell = document.getElementById("main");
  const dashWelcomeName = document.getElementById("dash-welcome-name");
  const dashHeroName = document.getElementById("dash-hero-name");
  const dashHeroMode = document.getElementById("dash-hero-mode");
  const dashAvatar = document.getElementById("dash-avatar");
  const dashMenu = document.getElementById("dash-menu");
  const dashScrim = document.getElementById("dash-scrim");
  const dashRing = document.getElementById("dash-ring");
  const dashPct = document.getElementById("dash-pct");
  const dashPctCaption = document.getElementById("dash-pct-caption");
  const dashPctNote = document.getElementById("dash-pct-note");
  const dashMeter = document.getElementById("dash-meter");
  const dashChecklist = document.getElementById("dash-checklist");
  const heroCta = document.getElementById("hero-cta");
  const qaView = document.getElementById("qa-view");
  const qaEdit = document.getElementById("qa-edit");
  const qaAvailability = document.getElementById("qa-availability");
  const goToDashboardBtn = document.getElementById("go-to-dashboard");
  const statSubjectsValue = document.getElementById("stat-subjects-value");
  const statSubjectsMeta = document.getElementById("stat-subjects-meta");
  const statQualsValue = document.getElementById("stat-quals-value");
  const statQualsMeta = document.getElementById("stat-quals-meta");
  const statExpValue = document.getElementById("stat-exp-value");
  const statExpMeta = document.getElementById("stat-exp-meta");
  const statDaysValue = document.getElementById("stat-days-value");
  const statDaysMeta = document.getElementById("stat-days-meta");

  // My Profile: overview + inline editing (, Part 2).
  const profileOverviewPanel = document.getElementById("profile-overview-panel");
  const profileOverviewList = document.getElementById("profile-overview-list");
  const profileStatus = document.getElementById("profile-status");
  const profileEditBtn = document.getElementById("profile-edit-btn");
  const profileEditPanel = document.getElementById("profile-edit-panel");
  const profileEditMount = document.getElementById("profile-edit-mount");
  const profileEditAlert = document.getElementById("profile-edit-alert");
  const profileEditAlertList = document.getElementById("profile-edit-alert-list");
  const profileSaveBtn = document.getElementById("profile-save");
  const profileCancelBtn = document.getElementById("profile-cancel");

  // My Subjects: overview + inline editing (, Part 3).
  const subjectsOverviewPanel = document.getElementById("subjects-overview-panel");
  const subjectsOverview = document.getElementById("subjects-overview");
  const subjectsStatus = document.getElementById("subjects-status");
  const subjectsEditBtn = document.getElementById("subjects-edit-btn");
  const subjectsEditPanel = document.getElementById("subjects-edit-panel");
  const subjectsEditMount = document.getElementById("subjects-edit-mount");
  const subjectsEditAlert = document.getElementById("subjects-edit-alert");
  const subjectsEditAlertList = document.getElementById("subjects-edit-alert-list");
  const subjectsSaveBtn = document.getElementById("subjects-save");
  const subjectsCancelBtn = document.getElementById("subjects-cancel");

  // My Availability: overview + inline editing (, Part 4).
  const availabilityOverviewPanel = document.getElementById("availability-overview-panel");
  const availabilityOverview = document.getElementById("availability-overview");
  const availabilityStatus = document.getElementById("availability-status");
  const availabilityEditBtn = document.getElementById("availability-edit-btn");
  const availabilityEditPanel = document.getElementById("availability-edit-panel");
  const availabilityEditMount = document.getElementById("availability-edit-mount");
  const availabilityEditAlert = document.getElementById("availability-edit-alert");
  const availabilityEditAlertList = document.getElementById("availability-edit-alert-list");
  const availabilitySaveBtn = document.getElementById("availability-save");
  const availabilityCancelBtn = document.getElementById("availability-cancel");

  // Tab hashes let each sidebar section be linked, refreshed and reached with
  // the browser Back/Forward buttons.
  const DASH_TABS = {
    home: "#/dashboard",
    profile: "#/dashboard/profile",
    documents: "#/dashboard/documents",
    subjects: "#/dashboard/subjects",
    availability: "#/dashboard/availability",
    pricing: "#/dashboard/pricing",
    notifications: "#/dashboard/notifications",
    requests: "#/dashboard/requests",
    reviews: "#/dashboard/reviews",
    attendance: "#/dashboard/attendance",
    settings: "#/dashboard/settings",
  };
  // Setup sections that live outside the dashboard but are still reachable from
  // its flow (for example, the profile review's Edit links); these get a
  // "Back to dashboard" chip once the dashboard has been opened.
  const DASH_REUSED_VIEWS = { profile: true, subjects: true, availability: true, review: true };

  let dashboardUnlocked = false; // becomes true the first time the dashboard opens
  let dashNavOpen = false;

  function dashTabFromHash(hash) {
    const h = String(hash || "").toLowerCase().replace(/\/+$/, "");
    const docVerificationEnabled = platformSettings && platformSettings.general && platformSettings.general.requireTeacherDocumentVerification !== false;
    if (h === "#/dashboard/profile") return "profile";
    if (h === "#/dashboard/documents") return docVerificationEnabled ? "documents" : "home";
    if (h === "#/dashboard/subjects") return "subjects";
    if (h === "#/dashboard/availability") return "availability";
    if (h === "#/dashboard/pricing") return "pricing";
    if (h === "#/dashboard/notifications") return "notifications";
    if (h === "#/dashboard/requests") return "requests";
    if (h === "#/dashboard/reviews") return "reviews";
    if (h === "#/dashboard/attendance") return "attendance";
    if (h === "#/dashboard/settings") return "settings";
    return "home";
  }

  // Push a dashboard tab into history (guarded — some environments block the
  // History API) and redraw.
  function showDashTab(tab) {
    const hash = DASH_TABS[tab] || DASH_TABS.home;
    if (location.hash !== hash) {
      try {
        history.pushState({ view: "dashboard", tab: tab }, "", hash);
      } catch (err) {
        try {
          location.hash = hash;
        } catch (err2) {
          /* ignore — the tab still renders below */
        }
      }
    }
    renderView("dashboard");
  }

  function dashboardName() {
    return pName.value.trim() || tName.value.trim();
  }

  function locationStateValue() {
    return locStateTextControl.hidden ? locState.value : locStateText.value.trim();
  }

  function filledQualificationCount() {
    let count = 0;
    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      let filled = false;
      row.querySelectorAll("[data-qual-input]").forEach(function (input) {
        if (input.value.trim()) filled = true;
      });
      if (filled) count += 1;
    });
    return count;
  }

  // One checkpoint per meaningful profile field. The percentage is derived from
  // this list — nothing is hardcoded.
  function completionCheckpoints() {
    const subjects = selectedSubjects();
    const grades = checkedLabels(gradeGrid, "data-grade", GRADE_OPTIONS);
    const hasSlot = selectedDayObjects().some(function (day) {
      return availabilitySlots[day.id].some(function (slot) {
        return timeToMinutes(slot.start) !== null && timeToMinutes(slot.end) !== null;
      });
    });
    const hasLocation = !!locCountry.value && !!locationStateValue() && !!locCity.value.trim();
    return [
      { label: "Full name", done: !!pName.value.trim(), required: true },
      { label: "Contact email", done: !validateEmailValue(pEmail.value), required: true },
      { label: "Short bio", done: pBio.value.trim().length >= BIO_MIN, required: false },
      { label: "Profile photo", done: !!photoObjectUrl, required: false },
      { label: "Qualifications", done: filledQualificationCount() > 0, required: true },
      { label: "Experience level", done: !!expLevel.value, required: true },
      { label: "Years of experience", done: expYears.value.trim() !== "", required: true },
      { label: "Subjects taught", done: subjects.length > 0, required: true },
      { label: "Classes or grades", done: grades.length > 0, required: true },
      { label: "Teaching mode", done: !!selectedMode(), required: true },
      { label: "Location", done: hasLocation, required: true },
      // The teaching hours are the teacher's own choice: a teacher may take
      // them all down for a while, so they are advice and not a requirement.
      { label: "Availability", done: availableDayIds.size > 0 && hasSlot, required: false },
    ];
  }

  function initialsFrom(name) {
    const parts = String(name || "").split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    const first = parts[0].charAt(0);
    const second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return (first + second).toUpperCase();
  }

  function subjectSummary(list) {
    const names = list.map(function (subject) {
      return subject.label;
    });
    const shown = names.slice(0, 3);
    const extra = names.length - shown.length;
    return shown.join(", ") + (extra > 0 ? " +" + extra + " more" : "");
  }

  function renderDashboardIdentity() {
    const name = dashboardName();
    const firstName = name ? name.split(/\s+/)[0] : "";
    const greeting = firstName || "Teacher";
    dashWelcomeName.textContent = greeting;
    dashHeroName.textContent = greeting;

    dashAvatar.innerHTML = "";
    if (photoObjectUrl) {
      const img = document.createElement("img");
      img.src = photoObjectUrl;
      img.alt = name ? "Profile photo of " + name : "Profile photo";
      dashAvatar.appendChild(img);
    } else {
      const initials = initialsFrom(name);
      if (initials) {
        dashAvatar.textContent = initials;
      } else {
        dashAvatar.innerHTML =
          '<svg width="22" height="22" aria-hidden="true"><use href="#i-user" /></svg>';
      }
    }

    const mode = MODE_LABELS[selectedMode()] || "";
    if (mode) {
      dashHeroMode.textContent = "Teaching mode: " + mode;
      dashHeroMode.hidden = false;
    } else {
      dashHeroMode.textContent = "";
      dashHeroMode.hidden = true;
    }

    // Say plainly whether the profile can be found by students. The server
    // decides this, so the note follows the server state and never guesses.
    const listing = document.getElementById("dash-hero-listing");
    if (listing) {
      const status = teacherListing.approvalStatus;
      const diag = teacherListing.diagnostic;
      let text = "";

      if (diag && diag.is_bookable) {
        text = "✓ Your profile is active, verified, and listed in Find Teachers.";
        listing.style.color = "var(--ink-700, #374151)";
      } else if (diag && diag.missing_reasons && diag.missing_reasons.length > 0) {
        text = "Listing pending: " + diag.missing_reasons[0];
        listing.style.color = "var(--amber-700, #b45309)";
      } else if (status === "approved" && teacherListing.isPublic) {
        text = "Your profile is listed in Find Teachers.";
        listing.style.color = "var(--ink-700, #374151)";
      } else if (status === "pending") {
        text = "Your profile is not listed yet. An administrator has to approve it before students can find you.";
        listing.style.color = "var(--ink-700, #374151)";
      } else if (status === "rejected") {
        text = "Your profile is not listed. An administrator has to approve it again before students can find you.";
        listing.style.color = "var(--danger-700, #b91c1c)";
      }
      listing.textContent = text;
      listing.hidden = !text;
    }
  }

  function renderDashboardCompletion() {
    const items = completionCheckpoints();
    // The photo and the short introduction are optional, so they are listed
    // as advice but never counted against the profile.
    const required = items.filter(function (item) {
      return item.required !== false;
    });
    const done = required.filter(function (item) {
      return item.done;
    }).length;
    const pct = required.length ? Math.round((done / required.length) * 100) : 0;

    dashPct.textContent = pct + "%";
    dashRing.style.setProperty("--pct", String(pct));
    dashRing.setAttribute("aria-label", "Profile completion " + pct + " percent");
    dashMeter.style.width = pct + "%";
    dashPctCaption.textContent = pct + "% complete";
    dashPctNote.textContent =
      pct === 100
        ? "All required details are filled in."
        : done + " of " + required.length + " required details captured.";

    const hint = document.getElementById("dash-completion-hint");
    if (hint) {
      hint.textContent =
        pct === 100
          ? "Your required profile setup is 100% complete! Adding an optional photo helps build extra trust with prospective students."
          : "Complete the remaining required fields to reach 100%. Photo and bio are optional enhancements.";
    }

    const countEl = document.getElementById("dash-checklist-count");
    if (countEl) {
      countEl.textContent = done + " of " + required.length + " required";
    }

    dashChecklist.innerHTML = "";
    items.forEach(function (item) {
      const isReq = item.required !== false;
      const li = document.createElement("li");
      if (item.done) {
        li.className = "is-done";
      } else if (!isReq) {
        li.className = "is-optional";
      }

      const mark = document.createElement("span");
      mark.className = "checklist__mark";
      mark.setAttribute("aria-hidden", "true");
      if (item.done) {
        mark.innerHTML = '<svg width="11" height="11" aria-hidden="true"><use href="#i-check" /></svg>';
      } else if (!isReq) {
        mark.innerHTML = '<span class="checklist__mark-opt" aria-hidden="true">+</span>';
      }

      const textWrap = document.createElement("span");
      textWrap.className = "checklist__text";

      const text = document.createElement("span");
      text.textContent = item.label;
      textWrap.appendChild(text);

      if (!isReq) {
        const badge = document.createElement("span");
        badge.className = "checklist__badge-optional";
        badge.textContent = "Optional";
        textWrap.appendChild(badge);
      }

      li.appendChild(mark);
      li.appendChild(textWrap);
      dashChecklist.appendChild(li);
    });
  }

  function renderDashboardStats() {
    const subjects = selectedSubjects();
    if (statSubjectsValue) statSubjectsValue.textContent = String(subjects.length);
    if (statSubjectsMeta) {
      statSubjectsMeta.textContent = subjects.length
        ? subjectSummary(subjects)
        : "No subjects selected yet.";
    }

    const quals = filledQualificationCount();
    if (statQualsValue) statQualsValue.textContent = String(quals);
    if (statQualsMeta) {
      statQualsMeta.textContent = quals
        ? quals === 1
          ? "1 qualification added."
          : quals + " qualifications added."
        : "No qualifications added yet.";
    }

    const levelText = expLevel.value ? selectedOptionText(expLevel) : "";
    const years = expYears.value.trim();
    if (statExpValue) statExpValue.textContent = levelText || "Not set";
    if (statExpMeta) {
      if (years) {
        statExpMeta.textContent =
          years + (Number(years) === 1 ? " year of experience" : " years of experience");
      } else if (levelText) {
        statExpMeta.textContent = "Years of experience not added yet.";
      } else {
        statExpMeta.textContent = "Add your experience in Qualifications.";
      }
    }

    const days = selectedDayObjects();
    const daySlots = availabilitySlotCount(days);
    if (statDaysValue) statDaysValue.textContent = String(days.length);
    if (statDaysMeta) {
      statDaysMeta.textContent = days.length
        ? days
            .map(function (day) {
              return day.label.slice(0, 3);
            })
            .join(", ") +
          (daySlots
            ? " \u00b7 " + daySlots + (daySlots === 1 ? " time slot." : " time slots.")
            : ".")
        : "No available days selected yet.";
    }

    // Availability card in Dashboard Profile Overview
    const dashAvailBadge = document.getElementById("dash-avail-count-badge");
    const dashAvailMeta = document.getElementById("dash-avail-meta");
    const dashAvailStrip = document.getElementById("dash-avail-week-strip");

    if (dashAvailBadge) {
      dashAvailBadge.textContent = days.length
        ? days.length + (days.length === 1 ? " day active" : " days active")
        : "0 days active";
      dashAvailBadge.className =
        "dash-avail-card__badge" + (days.length === 0 ? " is-zero" : "");
    }

    if (dashAvailMeta) {
      if (days.length && daySlots) {
        dashAvailMeta.textContent =
          daySlots + (daySlots === 1 ? " time slot scheduled across active days." : " time slots scheduled across active days.");
      } else if (days.length) {
        dashAvailMeta.textContent = "Teaching days selected, but no time slots added yet.";
      } else {
        dashAvailMeta.textContent = "No teaching days selected yet. Click Edit to configure your schedule.";
      }
    }

    if (dashAvailStrip) {
      dashAvailStrip.innerHTML = "";
      DAYS.forEach(function (day) {
        const isActive = availableDayIds.has(day.id);
        const pill = document.createElement("span");
        pill.className = "avail-week-pill " + (isActive ? "is-active" : "is-off");
        pill.setAttribute("title", day.label + ": " + (isActive ? "Active teaching day" : "Day off"));
        pill.innerHTML =
          '<span class="avail-week-pill__dot" aria-hidden="true"></span>' +
          '<span class="avail-week-pill__name">' + day.label.slice(0, 3) + '</span>' +
          '<span class="avail-week-pill__status">' + (isActive ? "Active" : "Off") + '</span>';
        dashAvailStrip.appendChild(pill);
      });
    }
  }

  function renderDashboard(focus) {
    dashboardUnlocked = true;
    const tab = dashTabFromHash(location.hash);

    // Leaving the profile tab while editing discards the unsaved edit session
    // (the same rule Cancel follows) so no half-finished values leak elsewhere.
    if (profileEditSession && tab !== "profile") {
      cancelProfileEdit({ silent: true, announce: true });
    }
    if (subjectsEditSession && tab !== "subjects") {
      cancelSubjectsEdit({ silent: true, announce: true });
    }
    if (availabilityEditSession && tab !== "availability") {
      cancelAvailabilityEdit({ silent: true, announce: true });
    }

    const docVerificationEnabled = platformSettings.general.requireTeacherDocumentVerification !== false;
    const docNavBtn = document.getElementById("dash-nav-documents");
    if (docNavBtn) docNavBtn.hidden = !docVerificationEnabled;
    const qaDocsBtn = document.getElementById("qa-documents");
    if (qaDocsBtn) qaDocsBtn.hidden = !docVerificationEnabled;
    const bannerPanel = document.getElementById("dash-panel-doc-verification-banner");
    if (bannerPanel && !docVerificationEnabled) bannerPanel.hidden = true;

    if (!docVerificationEnabled && tab === "documents") {
      showDashTab("home");
      return;
    }

    dashboardView.querySelectorAll("[data-nav]").forEach(function (btn) {
      const nav = btn.getAttribute("data-nav");
      const isTab =
        nav === "home" ||
        nav === "profile" ||
        nav === "documents" ||
        nav === "subjects" ||
        nav === "availability" ||
        nav === "pricing" ||
        nav === "notifications" ||
        nav === "requests" ||
        nav === "reviews" ||
        nav === "attendance" ||
        nav === "settings";
      const active = isTab && nav === tab;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    dashboardView.querySelectorAll("[data-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-panel") !== tab;
    });

    renderDashboardIdentity();
    renderDashboardCompletion();
    renderDashboardStats();
    if (tab === "home" && docVerificationEnabled) renderTeacherDocBanner();
    if (tab === "documents" && docVerificationEnabled) renderTeacherDocumentsPanel();
    if (tab === "profile") renderProfileOverview();
    
    if (tab === "requests") renderTeacherRequests();
    // Reviews and ratings the server holds for this teacher.
    if (tab === "reviews") renderTeacherReviewsPanel();
    
    if (tab === "attendance") renderTeacherAttendance();
    
    if (tab === "pricing") renderPricingForm();
    
    if (tab === "notifications") renderNotificationCenter("dash");
    if (tab === "attendance") { renderAttendanceStats("att-stats", teacherAttendance()); }
    updateRequestsBadge();
    if (tab === "subjects") renderSubjectsOverview();
    if (tab === "availability") renderAvailabilityOverview();
    setDashNav(false);

    if (focus !== false) {
      const activePanel = dashboardView.querySelector('[data-panel="' + tab + '"]');
      const heading = activePanel ? activePanel.querySelector("h1, h2") : null;
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    }
  }

  /* ================= My Profile: overview & editing (, Part 2) ==== */
  // Editing reuses the five existing setup forms instead of duplicating them:
  // while a session is open they are moved into the dashboard's edit panel, and
  // put straight back on exit. Save keeps the current values; Cancel restores a
  // snapshot taken when the session began.
  const PROFILE_EDIT_SECTIONS = [
    { key: "basics", title: "Basics", form: profileForm },
    { key: "qualifications", title: "Qualifications & experience", form: qualForm },
    { key: "subjects", title: "Subjects & classes", form: subjectsForm },
    { key: "location", title: "Location & teaching mode", form: locationForm },
    { key: "availability", title: "Availability", form: availabilityForm },
  ];

  function overviewEditHandler(key) {
    return function () {
      beginProfileEdit(key);
    };
  }

  // Builds the read-only overview using the same card builders as the setup
  // review screen, just pointed at the dashboard's list.
  function renderProfileOverview() {
    if (!profileOverviewList) return;
    // Feedback belongs to the action that just happened; a fresh render (for
    // example, closing the dashboard and coming back) starts clean.
    hideProfileStatus();
    reviewTarget = profileOverviewList;
    profileOverviewList.innerHTML = "";
    buildBasicsReview(overviewEditHandler("basics"));
    buildQualificationsReview(overviewEditHandler("qualifications"));
    buildSubjectsReview(overviewEditHandler("subjects"));
    buildLocationReview(overviewEditHandler("location"));
    buildAvailabilityReview(overviewEditHandler("availability"));
  }

  function showProfileStatus(message, kind) {
    if (!profileStatus) return;
    const success = kind === "success";
    profileStatus.className =
      "profile-status " + (success ? "profile-status--success" : "profile-status--info");
    profileStatus.innerHTML =
      '<svg width="16" height="16" aria-hidden="true"><use href="' +
      (success ? "#i-check" : "#i-info") +
      '" /></svg><span></span>';
    profileStatus.querySelector("span").textContent = message;
    profileStatus.hidden = false;
  }

  function hideProfileStatus() {
    if (!profileStatus) return;
    profileStatus.hidden = true;
    profileStatus.innerHTML = "";
  }

  /* ----------------------- snapshot & restore -------------------------- */
  function captureProfileState() {
    const quals = [];
    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      const values = {};
      row.querySelectorAll("[data-qual-input]").forEach(function (input) {
        values[input.getAttribute("data-qual-input")] = input.value;
      });
      quals.push(values);
    });

    const slots = {};
    DAYS.forEach(function (day) {
      slots[day.id] = availabilitySlots[day.id].map(function (slot) {
        return { start: slot.start, end: slot.end };
      });
    });

    return {
      name: pName.value,
      email: pEmail.value,
      bio: pBio.value,
      photo: photoObjectUrl,
      expLevel: expLevel.value,
      expYears: expYears.value,
      expOrg: expOrg.value,
      expDesc: expDesc.value,
      quals: quals,
      subjectIds: Array.from(subjectGrid.querySelectorAll("[data-subject]:checked")).map(function (i) {
        return i.value;
      }),
      customSubjects: customSubjects.map(function (c) {
        return { key: c.key, label: c.label };
      }),
      gradeIds: Array.from(gradeGrid.querySelectorAll("[data-grade]:checked")).map(function (i) {
        return i.getAttribute("data-grade");
      }),
      streamIds: Array.from(streamGrid.querySelectorAll("[data-stream]:checked")).map(function (i) {
        return i.getAttribute("data-stream");
      }),
      otherLevel: otherLevel.value,
      mode: selectedMode(),
      country: locCountry.value,
      state: locState.value,
      stateText: locStateText.value,
      city: locCity.value,
      area: locArea.value,
      radius: locRadius.value,
      onlineTools: locOnlineTools.value,
      dayIds: Array.from(availableDayIds),
      slots: slots,
    };
  }

  function applyPhotoUrl(url) {
    photoObjectUrl = url || null;
    if (photoObjectUrl) {
      photoImg.src = photoObjectUrl;
      photoImg.hidden = false;
      photoPreview.classList.add("has-image");
      photoRemove.hidden = false;
    } else {
      photoImg.removeAttribute("src");
      photoImg.hidden = true;
      photoPreview.classList.remove("has-image");
      photoRemove.hidden = true;
    }
    photoInput.value = "";
  }

  function restoreProfileState(state) {
    pendingTeacherPhotoFile = null;
    pName.value = state.name;
    pEmail.value = state.email;
    pBio.value = state.bio;
    applyPhotoUrl(state.photo);

    expLevel.value = state.expLevel;
    expYears.value = state.expYears;
    expOrg.value = state.expOrg;
    expDesc.value = state.expDesc;

    qualList.innerHTML = "";
    if (state.quals.length) {
      state.quals.forEach(function (values) {
        addQualificationRow(values);
      });
    } else {
      addQualificationRow();
    }

    subjectGrid.querySelectorAll("[data-subject]").forEach(function (input) {
      input.checked = state.subjectIds.indexOf(input.value) !== -1;
    });
    customSubjects = state.customSubjects.map(function (c) {
      return { key: c.key, label: c.label };
    });
    gradeGrid.querySelectorAll("[data-grade]").forEach(function (input) {
      input.checked = state.gradeIds.indexOf(input.getAttribute("data-grade")) !== -1;
    });
    streamGrid.querySelectorAll("[data-stream]").forEach(function (input) {
      input.checked = state.streamIds.indexOf(input.getAttribute("data-stream")) !== -1;
    });
    otherLevel.value = state.otherLevel;
    renderSubjectChips();
    toggleConditionalFields();

    modeList.querySelectorAll("[data-mode]").forEach(function (input) {
      input.checked = input.value === state.mode;
    });
    syncModeCards();
    locCountry.value = state.country;
    populateStates();
    locState.value = state.state;
    locStateText.value = state.stateText;
    locCity.value = state.city;
    locArea.value = state.area;
    locRadius.value = state.radius;
    locOnlineTools.value = state.onlineTools;
    updateConditionalFields();

    availableDayIds.clear();
    state.dayIds.forEach(function (id) {
      availableDayIds.add(id);
    });
    DAYS.forEach(function (day) {
      availabilitySlots[day.id] = state.slots[day.id].map(function (slot) {
        return { start: slot.start, end: slot.end };
      });
    });
    dayGrid.querySelectorAll("[data-day]").forEach(function (input) {
      input.checked = availableDayIds.has(input.getAttribute("data-day"));
    });
    renderAvailabilityDays();

    syncCheckStates();

    // Refresh the live character counters the way typing would.
    [pBio, expDesc, locOnlineTools].forEach(function (input) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /* ------------------------- edit session ------------------------------ */
  function releasePhotoUrls(except) {
    photoUrlsToRelease.forEach(function (url) {
      if (url && url !== except) {
        try {
          URL.revokeObjectURL(url);
        } catch (err) {
          /* ignore - a stale preview URL is harmless */
        }
      }
    });
    photoUrlsToRelease = [];
  }

  // The setup forms each have their own submit handler (they advance the
  // wizard). While they live in the edit panel those must not fire.
  function blockEditSubmit(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function beginProfileEdit(focusKey) {
    if (profileEditSession || !profileEditMount) return;

    profileEditMount.innerHTML = "";
    photoUrlsToRelease = [];

    const moves = [];
    const actions = [];

    PROFILE_EDIT_SECTIONS.forEach(function (section) {
      const block = document.createElement("section");
      block.className = "edit-block";
      block.setAttribute("data-edit-block", section.key);

      const title = document.createElement("h3");
      title.className = "edit-block__title";
      title.textContent = section.title;
      block.appendChild(title);

      moves.push({
        form: section.form,
        parent: section.form.parentElement,
        next: section.form.nextSibling,
        hidden: section.form.hidden,
      });

      block.appendChild(section.form);
      section.form.hidden = false;

      section.form.querySelectorAll(".form__actions").forEach(function (bar) {
        actions.push({ el: bar, hidden: bar.hidden });
        bar.hidden = true;
      });

      profileEditMount.appendChild(block);
    });

    profileEditSession = { moves: moves, actions: actions, snapshot: captureProfileState() };
    profileEditMount.addEventListener("submit", blockEditSubmit, true);

    try {
      clearAllErrors();
    } catch (err) {
      /* ignore - clearing messages must not block editing */
    }
    hideProfileStatus();
    profileEditAlert.hidden = true;
    profileEditAlertList.innerHTML = "";

    profileOverviewPanel.hidden = true;
    profileEditPanel.hidden = false;

    const block = focusKey
      ? profileEditMount.querySelector('[data-edit-block="' + focusKey + '"]')
      : null;
    if (block) {
      block.scrollIntoView({ behavior: "smooth", block: "start" });
      const control = block.querySelector("input, select, textarea");
      if (control) control.focus({ preventScroll: true });
    } else {
      const heading = document.getElementById("profile-edit-title");
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  function endProfileEditDom() {
    if (!profileEditSession) return;
    profileEditSession.moves
      .slice()
      .reverse()
      .forEach(function (move) {
        if (move.next && move.next.parentElement === move.parent) {
          move.parent.insertBefore(move.form, move.next);
        } else {
          move.parent.appendChild(move.form);
        }
      });
    profileEditSession.moves.forEach(function (move) {
      move.form.hidden = move.hidden;
    });
    profileEditSession.actions.forEach(function (bar) {
      bar.el.hidden = bar.hidden;
    });
    profileEditMount.removeEventListener("submit", blockEditSubmit, true);
    profileEditMount.innerHTML = "";
  }

  function exitProfileEdit() {
    endProfileEditDom();
    resetSubjectsScratch();
    profileEditSession = null;
    profileOverviewPanel.hidden = false;
    profileEditPanel.hidden = true;
    profileEditAlert.hidden = true;
    profileEditAlertList.innerHTML = "";
  }

  function showEditIssues(issues) {
    profileEditAlertList.innerHTML = "";
    issues.forEach(function (issue) {
      const li = document.createElement("li");
      li.textContent = issue.message;
      profileEditAlertList.appendChild(li);
    });
    profileEditAlert.hidden = false;

    const firstInvalid = profileEditMount.querySelector(
      ".field.is-invalid input, .field.is-invalid select, .field.is-invalid textarea"
    );
    if (firstInvalid) {
      profileEditAlert.scrollIntoView({ behavior: "smooth", block: "nearest" });
      firstInvalid.focus({ preventScroll: true });
    } else {
      profileEditAlert.focus({ preventScroll: true });
    }
  }

  async function saveProfileEdit() {
    if (!profileEditSession) return;
    const issues = validateAllProfileSections();
    if (issues.length) {
      showEditIssues(issues);
      return;
    }
    profileSaveBtn.disabled = true;
    try {
      await saveTeacherSection("all");
      const keptPhoto = photoObjectUrl;
      exitProfileEdit();
      releasePhotoUrls(keptPhoto);
      renderProfileOverview();
      renderSubjectsOverview();
      renderAvailabilityOverview();
      renderDashboardIdentity();
      renderDashboardCompletion();
      renderDashboardStats();
      showProfileStatus("Your profile has been updated.", "success");
    } catch (error) {
      showTeacherApiError(error, {});
    } finally {
      profileSaveBtn.disabled = false;
    }
  }

  function cancelProfileEdit(options) {
    if (!profileEditSession) return;
    const opts = options || {};
    const snapshot = profileEditSession.snapshot;
    restoreProfileState(snapshot);
    exitProfileEdit();
    releasePhotoUrls(snapshot.photo);
    renderProfileOverview();
    renderSubjectsOverview();
    renderAvailabilityOverview();
    renderDashboardIdentity();
    renderDashboardCompletion();
    renderDashboardStats();
    if (!opts.silent) {
      showProfileStatus("Changes discarded \u2014 your previous details were restored.", "info");
    } else if (opts.announce) {
      showToast("Unsaved profile changes were discarded.");
    }
  }

  profileEditBtn.addEventListener("click", function () {
    beginProfileEdit();
  });
  profileSaveBtn.addEventListener("click", function () {
    saveProfileEdit();
  });
  profileCancelBtn.addEventListener("click", function () {
    cancelProfileEdit();
  });

  /* =============== My Subjects & classes (, Part 3) ============== */
  // The My Subjects tab reads and edits the SAME in-memory subject / grade /
  // stream state the setup wizard fills in, so there is never a second copy of
  // the data. Editing relocates the existing subjects form into the dashboard
  // panel and blocks its wizard submit until the session ends.
  function subjectSelection() {
    const eleven = gradeGrid.querySelector('[data-grade="11-12"]');
    const other = gradeGrid.querySelector('[data-grade="other"]');
    return {
      subjects: selectedSubjects(),
      grades: checkedLabels(gradeGrid, "data-grade", GRADE_OPTIONS),
      streams: checkedLabels(streamGrid, "data-stream", STREAM_OPTIONS),
      showsStreams: !!(eleven && eleven.checked),
      otherChecked: !!(other && other.checked),
      otherText: other && other.checked ? otherLevel.value.trim() : "",
    };
  }

  // Respect the visitor's reduced-motion preference for the few scrolls this
  // section performs in JavaScript.
  function subjectsScrollBehavior() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    } catch (err) {
      return "auto";
    }
  }

  // Subject tags carry a "Custom" flag so teacher-added subjects are distinct
  // from the fixed list without inventing a category for them.
  function subjectsTagList(list) {
    const wrap = document.createElement("div");
    wrap.className = "review-tags";
    list.forEach(function (subject) {
      const tag = document.createElement("span");
      tag.className = "review-tag" + (subject.common ? "" : " review-tag--custom");
      tag.textContent = subject.label;
      if (!subject.common) {
        const flag = document.createElement("span");
        flag.className = "review-tag__flag";
        flag.textContent = "Custom";
        tag.appendChild(flag);
      }
      wrap.appendChild(tag);
    });
    return wrap;
  }

  function subjectsFallback(text) {
    const p = document.createElement("p");
    p.className = "review-row__value";
    p.textContent = text;
    return p;
  }

  function subjectsGroupCard(title, node) {
    const card = document.createElement("section");
    card.className = "review-card subjects-card";

    const head = document.createElement("div");
    head.className = "review-card__head";
    const heading = document.createElement("h3");
    heading.className = "review-card__title";
    heading.textContent = title;
    head.appendChild(heading);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "review-card__body";
    body.appendChild(node);
    card.appendChild(body);
    return card;
  }

  function renderSubjectsOverview() {
    if (!subjectsOverview) return;
    hideSubjectsStatus();
    subjectsOverview.innerHTML = "";

    const sel = subjectSelection();

    // Nothing chosen yet: explain how to fill it in. Never invent any details.
    if (!sel.subjects.length && !sel.grades.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML =
        '<span class="empty-state__icon" aria-hidden="true">' +
        '<svg width="26" height="26" aria-hidden="true"><use href="#i-book" /></svg></span>' +
        '<p class="empty-state__title">No subjects or classes yet</p>' +
        '<p class="empty-state__text">The subjects you teach and the levels you take will be listed ' +
        "here once you choose them. Nothing is added for you, so this stays empty until you pick " +
        "something.</p>";
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "btn btn--primary soon__action";
      cta.innerHTML = '<span class="btn__label">Add subjects &amp; classes</span>';
      cta.addEventListener("click", function () {
        beginSubjectsEdit(true);
      });
      empty.appendChild(cta);
      subjectsOverview.appendChild(empty);
      return;
    }

    // A quick count strip, built from the real selections only.
    const summary = document.createElement("div");
    summary.className = "subjects-summary";
    const parts = [
      { count: sel.subjects.length, label: sel.subjects.length === 1 ? "subject" : "subjects" },
      { count: sel.grades.length, label: sel.grades.length === 1 ? "class level" : "class levels" },
    ];
    if (sel.streams.length) {
      parts.push({
        count: sel.streams.length,
        label: sel.streams.length === 1 ? "stream" : "streams",
      });
    }
    parts.forEach(function (part) {
      const item = document.createElement("span");
      item.className = "subjects-summary__item";
      item.setAttribute("aria-label", part.count + " " + part.label);
      const num = document.createElement("strong");
      num.textContent = String(part.count);
      const text = document.createElement("span");
      text.textContent = part.label;
      item.appendChild(num);
      item.appendChild(text);
      summary.appendChild(item);
    });
    subjectsOverview.appendChild(summary);

    subjectsOverview.appendChild(
      subjectsGroupCard(
        "Subjects taught",
        sel.subjects.length
          ? subjectsTagList(sel.subjects)
          : subjectsFallback("No subjects selected")
      )
    );

    subjectsOverview.appendChild(
      subjectsGroupCard(
        "Grades & classes",
        sel.grades.length
          ? reviewTagList(sel.grades)
          : subjectsFallback("No grades or classes selected")
      )
    );

    if (sel.showsStreams) {
      subjectsOverview.appendChild(
        subjectsGroupCard(
          "Stream (Classes 11\u201312)",
          sel.streams.length
            ? reviewTagList(sel.streams)
            : subjectsFallback("No stream selected")
        )
      );
    }

    if (sel.otherChecked) {
      subjectsOverview.appendChild(
        subjectsGroupCard(
          "Other level",
          sel.otherText ? subjectsFallback(sel.otherText) : subjectsFallback("Not provided yet")
        )
      );
    }
  }

  function showSubjectsStatus(message, kind) {
    if (!subjectsStatus) return;
    const success = kind === "success";
    subjectsStatus.className =
      "profile-status " + (success ? "profile-status--success" : "profile-status--info");
    subjectsStatus.innerHTML =
      '<svg width="16" height="16" aria-hidden="true"><use href="' +
      (success ? "#i-check" : "#i-info") +
      '" /></svg><span></span>';
    subjectsStatus.querySelector("span").textContent = message;
    subjectsStatus.hidden = false;
  }

  function hideSubjectsStatus() {
    if (!subjectsStatus) return;
    subjectsStatus.hidden = true;
    subjectsStatus.innerHTML = "";
  }

  // Only the subject-related rules run on Save, so editing subjects never
  // blocks on (or rewrites) unrelated profile sections.
  function validateSubjectSelection() {
    const subjectMessage = validateSubjects();
    const gradeMessage = validateGrades();
    const streamMessage = validateStreams();
    const otherLevelMessage = validateOtherLevel();
    setFieldError("subjects", subjectMessage);
    setFieldError("grades", gradeMessage);
    setFieldError("subject-stream", streamMessage);
    setFieldError("subject-grade-other", otherLevelMessage);
    return [subjectMessage, gradeMessage, streamMessage, otherLevelMessage].filter(Boolean);
  }

  function showSubjectsEditIssues(issues) {
    subjectsEditAlertList.innerHTML = "";
    issues.forEach(function (message) {
      const li = document.createElement("li");
      li.textContent = message;
      subjectsEditAlertList.appendChild(li);
    });
    subjectsEditAlert.hidden = false;

    const firstInvalid = subjectsEditMount.querySelector(
      ".field.is-invalid input, .field.is-invalid select, .field.is-invalid textarea"
    );
    subjectsEditAlert.scrollIntoView({ behavior: subjectsScrollBehavior(), block: "nearest" });
    if (firstInvalid) firstInvalid.focus({ preventScroll: true });
    else subjectsEditAlert.focus({ preventScroll: true });
  }

  function beginSubjectsEdit(focusSearch) {
    if (subjectsEditSession || !subjectsEditMount) return;

    subjectsEditMount.innerHTML = "";

    const actions = [];
    subjectsForm.querySelectorAll(".form__actions").forEach(function (bar) {
      actions.push({ el: bar, hidden: bar.hidden });
      bar.hidden = true;
    });

    subjectsEditSession = {
      parent: subjectsForm.parentElement,
      next: subjectsForm.nextSibling,
      hidden: subjectsForm.hidden,
      actions: actions,
      snapshot: captureProfileState(),
    };

    subjectsEditMount.appendChild(subjectsForm);
    subjectsForm.hidden = false;
    subjectsEditMount.addEventListener("submit", blockEditSubmit, true);

    try {
      clearSubjectsErrors();
    } catch (err) {
      /* ignore - clearing messages must not block editing */
    }
    subjectsEditAlert.hidden = true;
    subjectsEditAlertList.innerHTML = "";
    hideSubjectsStatus();

    subjectsOverviewPanel.hidden = true;
    subjectsEditPanel.hidden = false;

    const heading = document.getElementById("subjects-edit-title");
    if (heading) heading.focus({ preventScroll: true });

    if (focusSearch) {
      subjectsForm.scrollIntoView({ behavior: subjectsScrollBehavior(), block: "start" });
      if (subjectSearch) subjectSearch.focus({ preventScroll: true });
    }
  }

  function endSubjectsEditDom() {
    if (!subjectsEditSession) return;
    const session = subjectsEditSession;

    if (session.next && session.next.parentElement === session.parent) {
      session.parent.insertBefore(subjectsForm, session.next);
    } else {
      session.parent.appendChild(subjectsForm);
    }
    subjectsForm.hidden = session.hidden;
    session.actions.forEach(function (bar) {
      bar.el.hidden = bar.hidden;
    });

    subjectsEditMount.removeEventListener("submit", blockEditSubmit, true);
    subjectsEditMount.innerHTML = "";
  }

  function exitSubjectsEdit() {
    endSubjectsEditDom();
    resetSubjectsScratch();
    subjectsEditSession = null;
    subjectsOverviewPanel.hidden = false;
    subjectsEditPanel.hidden = true;
    subjectsEditAlert.hidden = true;
    subjectsEditAlertList.innerHTML = "";
  }

  async function saveSubjectsEdit() {
    if (!subjectsEditSession) return;
    const issues = validateSubjectSelection();
    if (issues.length) {
      showSubjectsEditIssues(issues);
      return;
    }
    subjectsSaveBtn.disabled = true;
    try {
      await saveTeacherSection("subjects");
      exitSubjectsEdit();
      // Refresh every screen that shows this shared state, straight away.
      renderSubjectsOverview();
      renderProfileOverview();
      renderDashboardStats();
      renderDashboardCompletion();
      showSubjectsStatus("Your subjects and classes have been updated.", "success");
      focusSubjectsOverviewHeading();
    } catch (error) {
      showTeacherApiError(error, TEACHER_SECTION_FIELDS.subjects);
    } finally {
      subjectsSaveBtn.disabled = false;
    }
  }

  function cancelSubjectsEdit(options) {
    if (!subjectsEditSession) return;
    const opts = options || {};
    restoreProfileState(subjectsEditSession.snapshot);
    exitSubjectsEdit();
    renderSubjectsOverview();
    renderProfileOverview();
    renderDashboardStats();
    renderDashboardCompletion();
    if (!opts.silent) {
      showSubjectsStatus("Changes discarded \u2014 your previous subjects and classes were restored.", "info");
      focusSubjectsOverviewHeading();
    } else if (opts.announce) {
      showToast("Unsaved subject changes were discarded.");
    }
  }

  function focusSubjectsOverviewHeading() {
    const heading = document.getElementById("subjects-overview-title");
    if (heading) heading.focus({ preventScroll: true });
  }

  subjectsEditBtn.addEventListener("click", function () {
    beginSubjectsEdit();
  });
  document.getElementById("subjects-back-dash").addEventListener("click", function () {
    showDashTab("home");
  });
  subjectsSaveBtn.addEventListener("click", function () {
    saveSubjectsEdit();
  });
  subjectsCancelBtn.addEventListener("click", function () {
    cancelSubjectsEdit();
  });

  /* ================= My Availability (, Part 4) =================== */
  // The availability screen reads and edits the SAME day/slot state the setup
  // wizard fills in. Editing temporarily moves the setup form into this panel,
  // so there is never a second copy of the teacher's availability.
  let availabilityEditSession = null;

  function availabilitySortedSlots(dayId) {
    return (availabilitySlots[dayId] || []).slice().sort(function (a, b) {
      const aStart = timeToMinutes(a.start);
      const bStart = timeToMinutes(b.start);
      if (aStart === null && bStart === null) return 0;
      if (aStart === null) return 1; // incomplete slots sit at the end
      if (bStart === null) return -1;
      return aStart - bStart;
    });
  }

  function availabilitySlotText(slot) {
    if (timeToMinutes(slot.start) === null || timeToMinutes(slot.end) === null) {
      return "Time not set";
    }
    return slotTimeLabel(slot);
  }

  function availabilitySlotCount(days) {
    return days.reduce(function (total, day) {
      return total + (availabilitySlots[day.id] || []).length;
    }, 0);
  }

  function renderAvailabilityOverview() {
    if (!availabilityOverview) return;
    hideAvailabilityStatus();
    availabilityOverview.innerHTML = "";

    const days = selectedDayObjects();

    // No saved days means no availability — never fill this in with defaults.
    if (!days.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML =
        '<span class="empty-state__icon" aria-hidden="true">' +
        '<svg width="26" height="26" aria-hidden="true"><use href="#i-clock" /></svg></span>' +
        '<p class="empty-state__title">No availability set yet</p>' +
        '<p class="empty-state__text">Your teaching days and time slots will appear here once you ' +
        "choose them. Nothing is added for you, so this stays empty until you set your availability.</p>";
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "btn btn--primary soon__action";
      cta.innerHTML = '<span class="btn__label">Add availability</span>';
      cta.addEventListener("click", function () {
        beginAvailabilityEdit();
      });
      empty.appendChild(cta);
      availabilityOverview.appendChild(empty);
      return;
    }

    const totalSlots = availabilitySlotCount(days);

    const summary = document.createElement("div");
    summary.className = "availability-summary";
    [
      { count: days.length, label: days.length === 1 ? "teaching day" : "teaching days" },
      { count: totalSlots, label: totalSlots === 1 ? "time slot" : "time slots" },
    ].forEach(function (part) {
      const item = document.createElement("span");
      item.className = "availability-summary__item";
      item.setAttribute("aria-label", part.count + " " + part.label);
      const num = document.createElement("strong");
      num.textContent = String(part.count);
      const text = document.createElement("span");
      text.textContent = part.label;
      item.appendChild(num);
      item.appendChild(text);
      summary.appendChild(item);
    });
    availabilityOverview.appendChild(summary);

    const grid = document.createElement("div");
    grid.className = "availability-grid";

    days.forEach(function (day) {
      const slots = availabilitySortedSlots(day.id);
      const card = document.createElement("section");
      card.className = "review-card availability-card";
      card.setAttribute("data-availability-day", day.id);

      const head = document.createElement("div");
      head.className = "review-card__head";

      const titleWrap = document.createElement("div");
      const title = document.createElement("h3");
      title.className = "review-card__title";
      title.textContent = day.label;

      const count = document.createElement("span");
      count.className = "avail-day__count";
      count.textContent = slots.length + (slots.length === 1 ? " time slot" : " time slots");

      titleWrap.appendChild(title);
      titleWrap.appendChild(count);
      head.appendChild(titleWrap);

      const editDayBtn = document.createElement("button");
      editDayBtn.type = "button";
      editDayBtn.className = "btn btn--ghost btn--sm availability-card__edit-btn";
      editDayBtn.innerHTML = '<svg width="13" height="13" aria-hidden="true"><use href="#i-edit" /></svg><span>Edit day</span>';
      editDayBtn.setAttribute("aria-label", "Edit availability for " + day.label);
      editDayBtn.addEventListener("click", function () {
        beginAvailabilityEdit();
        setTimeout(function () {
          const target = availabilityEditMount ? availabilityEditMount.querySelector('[data-day-panel="' + day.id + '"]') : null;
          if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            const firstInput = target.querySelector('input[type="time"]');
            if (firstInput) firstInput.focus({ preventScroll: true });
          }
        }, 60);
      });
      head.appendChild(editDayBtn);

      card.appendChild(head);

      const body = document.createElement("div");
      body.className = "review-card__body";

      if (slots.length) {
        const tags = document.createElement("div");
        tags.className = "review-tags";
        slots.forEach(function (slot) {
          const tag = document.createElement("span");
          tag.className = "review-tag availability-slot-tag";
          tag.textContent = availabilitySlotText(slot);
          tags.appendChild(tag);
        });
        body.appendChild(tags);
      } else {
        const noTimes = document.createElement("p");
        noTimes.className = "review-row__value";
        noTimes.textContent = "No time slots added for this day.";
        body.appendChild(noTimes);
      }

      card.appendChild(body);
      grid.appendChild(card);
    });

    availabilityOverview.appendChild(grid);
  }

  function showAvailabilityStatus(message, kind) {
    if (!availabilityStatus) return;
    const success = kind === "success";
    availabilityStatus.className =
      "profile-status " + (success ? "profile-status--success" : "profile-status--info");
    availabilityStatus.innerHTML =
      '<svg width="16" height="16" aria-hidden="true"><use href="' +
      (success ? "#i-check" : "#i-info") +
      '" /></svg><span></span>';
    availabilityStatus.querySelector("span").textContent = message;
    availabilityStatus.hidden = false;
  }

  function hideAvailabilityStatus() {
    if (!availabilityStatus) return;
    availabilityStatus.hidden = true;
    availabilityStatus.innerHTML = "";
  }

  function showAvailabilityEditIssues(issues, firstInvalid) {
    availabilityEditAlertList.innerHTML = "";
    issues.forEach(function (message) {
      const li = document.createElement("li");
      li.textContent = message;
      availabilityEditAlertList.appendChild(li);
    });
    availabilityEditAlert.hidden = false;

    availabilityEditAlert.scrollIntoView({ behavior: subjectsScrollBehavior(), block: "nearest" });
    if (firstInvalid && availabilityEditMount.contains(firstInvalid)) {
      firstInvalid.focus({ preventScroll: true });
    } else {
      const fallback = availabilityEditMount.querySelector(
        ".field.is-invalid input, .has-error input, input[type='time'], input[type='checkbox']"
      );
      if (fallback) fallback.focus({ preventScroll: true });
      else availabilityEditAlert.focus({ preventScroll: true });
    }
  }

  function beginAvailabilityEdit() {
    if (availabilityEditSession || !availabilityEditMount) return;

    availabilityEditMount.innerHTML = "";

    const actions = [];
    availabilityForm.querySelectorAll(".form__actions").forEach(function (bar) {
      actions.push({ el: bar, hidden: bar.hidden });
      bar.hidden = true;
    });

    availabilityEditSession = {
      parent: availabilityForm.parentElement,
      next: availabilityForm.nextSibling,
      hidden: availabilityForm.hidden,
      actions: actions,
      snapshot: captureProfileState(),
    };

    availabilityEditMount.appendChild(availabilityForm);
    availabilityForm.hidden = false;
    availabilityEditMount.addEventListener("submit", blockEditSubmit, true);

    try {
      clearAvailabilityErrors();
    } catch (err) {
      /* ignore - clearing messages must not block editing */
    }
    availabilityEditAlert.hidden = true;
    availabilityEditAlertList.innerHTML = "";
    hideAvailabilityStatus();

    availabilityOverviewPanel.hidden = true;
    availabilityEditPanel.hidden = false;

    const heading = document.getElementById("availability-edit-title");
    if (heading) heading.focus({ preventScroll: true });
  }

  function endAvailabilityEditDom() {
    if (!availabilityEditSession) return;
    const session = availabilityEditSession;

    if (session.next && session.next.parentElement === session.parent) {
      session.parent.insertBefore(availabilityForm, session.next);
    } else {
      session.parent.appendChild(availabilityForm);
    }
    availabilityForm.hidden = session.hidden;
    session.actions.forEach(function (bar) {
      bar.el.hidden = bar.hidden;
    });

    availabilityEditMount.removeEventListener("submit", blockEditSubmit, true);
    availabilityEditMount.innerHTML = "";
  }

  function exitAvailabilityEdit() {
    endAvailabilityEditDom();
    availabilityEditSession = null;
    availabilityOverviewPanel.hidden = false;
    availabilityEditPanel.hidden = true;
    availabilityEditAlert.hidden = true;
    availabilityEditAlertList.innerHTML = "";
  }

  async function saveAvailabilityEdit() {
    if (!availabilityEditSession) return;
    const result = validateAvailability();
    if (!result.ok) {
      showAvailabilityEditIssues(result.issues, result.firstInvalid);
      return;
    }
    availabilitySaveBtn.disabled = true;
    try {
      await saveTeacherSection("availability");
      exitAvailabilityEdit();
      // Refresh every surface that shows this shared state, straight away.
      renderAvailabilityOverview();
      renderProfileOverview();
      renderDashboardStats();
      renderDashboardCompletion();
      showAvailabilityStatus("Your availability has been updated.", "success");
      focusAvailabilityOverviewHeading();
    } catch (error) {
      showTeacherApiError(error, TEACHER_SECTION_FIELDS.availability);
    } finally {
      availabilitySaveBtn.disabled = false;
    }
  }

  function cancelAvailabilityEdit(options) {
    if (!availabilityEditSession) return;
    const opts = options || {};
    restoreProfileState(availabilityEditSession.snapshot);
    exitAvailabilityEdit();
    renderAvailabilityOverview();
    renderProfileOverview();
    renderDashboardStats();
    renderDashboardCompletion();
    if (!opts.silent) {
      showAvailabilityStatus("Changes discarded \u2014 your previous availability was restored.", "info");
      focusAvailabilityOverviewHeading();
    } else if (opts.announce) {
      showToast("Unsaved availability changes were discarded.");
    }
  }

  function focusAvailabilityOverviewHeading() {
    const heading = document.getElementById("availability-overview-title");
    if (heading) heading.focus({ preventScroll: true });
  }

  availabilityEditBtn.addEventListener("click", function () {
    beginAvailabilityEdit();
  });
  document.getElementById("availability-back-dash").addEventListener("click", function () {
    showDashTab("home");
  });
  document.getElementById("reviews-back-dash").addEventListener("click", function () {
    showDashTab("home");
  });
  availabilitySaveBtn.addEventListener("click", function () {
    saveAvailabilityEdit();
  });
  availabilityCancelBtn.addEventListener("click", function () {
    cancelAvailabilityEdit();
  });

  // Show a "Back to dashboard" chip on the reused teacher sections once the
  // dashboard has been visited. Injected here so the profile markup isn't
  // duplicated.
  function syncBackToDashboard(name) {
    // Only the teacher's reused setup sections ever receive this chip. Without
    // this guard the removal branch below would run for every other view and
    // delete the first .back-dash it found inside it — which silently stripped
    // the student dashboard's own Back buttons one per visit.
    if (!DASH_REUSED_VIEWS[name]) return;
    const target = views[name];
    if (!target) return;
    // The chip is always inserted as a direct child, so only look there.
    const existing = target.querySelector(":scope > .back-dash:not([data-static-back])");
    const shouldShow = dashboardUnlocked && DASH_REUSED_VIEWS[name];
    if (shouldShow && !existing) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "back-dash";
      btn.innerHTML =
        '<svg width="15" height="15" aria-hidden="true"><use href="#i-arrow-left" /></svg>' +
        "<span>Back to dashboard</span>";
      btn.addEventListener("click", function () {
        navigate("dashboard");
      });
      target.insertBefore(btn, target.firstChild);
    } else if (!shouldShow && existing) {
      existing.remove();
    }
  }

  function setDashNav(open) {
    dashNavOpen = !!open;
    dashboardView.classList.toggle("is-nav-open", dashNavOpen);
    dashMenu.setAttribute("aria-expanded", String(dashNavOpen));
    dashMenu.setAttribute("aria-label", dashNavOpen ? "Close navigation menu" : "Open navigation menu");
  }

  dashMenu.addEventListener("click", function () {
    setDashNav(!dashNavOpen);
  });
  dashScrim.addEventListener("click", function () {
    setDashNav(false);
  });

  // Sidebar + any in-panel "Back to dashboard" buttons share data-nav.
  dashboardView.querySelectorAll("[data-nav]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const nav = btn.getAttribute("data-nav");
      setDashNav(false);
      if (nav === "home" || nav === "profile" || nav === "documents" || nav === "subjects" || nav === "availability" ||
          nav === "pricing" ||
          nav === "notifications" ||
          nav === "requests" || nav === "reviews" || nav === "attendance" || nav === "settings") {
        showDashTab(nav);
      } else if (nav === "login") {
        // "Log out" ends the session on the server first; the sign-in screen
        // is only shown once the server has confirmed it.
        logoutSession("login");
      }
    });
  });

  heroCta.addEventListener("click", function () {
    showDashTab("profile");
  });
  qaView.addEventListener("click", function () {
    showDashTab("profile");
  });
  qaEdit.addEventListener("click", function () {
    showDashTab("profile");
    beginProfileEdit();
  });
  qaAvailability.addEventListener("click", function () {
    showDashTab("availability");
  });
  const dashAvailEditBtn = document.getElementById("dash-avail-edit-btn");
  if (dashAvailEditBtn) {
    dashAvailEditBtn.addEventListener("click", function () {
      showDashTab("availability");
    });
  }
  goToDashboardBtn.addEventListener("click", function () {
    navigate("dashboard");
  });

  /* ================= Teacher Document Verification ================= */
  let teacherDocumentsState = null;

  async function loadTeacherDocuments() {
    try {
      const res = await apiRequest("/teacher/documents");
      if (res && res.data) {
        teacherDocumentsState = res.data;
        teacherListing.documentsVerified = res.data.status === "verified";
        teacherListing.documentVerificationStatus = res.data.status || "not_uploaded";
        teacherListing.idDocument = res.data.id_document;
        teacherListing.qualificationDocument = res.data.qualification_document;
        teacherListing.documentRejectionReason = res.data.rejection_reason;
      }
    } catch (e) {
      /* ignore */
    }
  }

  function renderTeacherDocBanner() {
    const banner = document.getElementById("dash-panel-doc-verification-banner");
    if (!banner) return;
    const enabled = platformSettings.general.requireTeacherDocumentVerification !== false;
    if (!enabled) {
      banner.hidden = true;
      return;
    }

    const st = teacherDocumentsState || {
      status: teacherListing.documentVerificationStatus || "not_uploaded",
      rejection_reason: teacherListing.documentRejectionReason || "",
    };

    const pill = document.getElementById("dash-doc-verify-pill");
    const desc = document.getElementById("dash-doc-verify-desc");
    const cta = document.getElementById("dash-doc-verify-cta");
    const icon = document.getElementById("dash-doc-verify-icon");

    banner.hidden = false;

    if (st.status === "verified") {
      pill.className = "status status--accepted";
      pill.textContent = "Verified ✓";
      desc.textContent = "Your Government ID and Qualification certificates are approved. Your public profile displays the verified badge to students.";
      cta.firstElementChild.textContent = "View Documents";
      if (icon) {
        icon.style.background = "rgba(16,185,129,0.12)";
        icon.style.color = "#059669";
      }
    } else if (st.status === "pending") {
      pill.className = "status status--pending";
      pill.textContent = "Under Review ⏳";
      desc.textContent = "Your documents have been submitted and are currently awaiting administrator review and approval.";
      cta.firstElementChild.textContent = "Manage Documents";
      if (icon) {
        icon.style.background = "rgba(245,158,11,0.12)";
        icon.style.color = "#d97706";
      }
    } else if (st.status === "rejected") {
      pill.className = "status status--rejected";
      pill.textContent = "Action Required ⚠️";
      desc.textContent = "Document verification was rejected: " + (st.rejection_reason || "Please check feedback and re-upload valid documents.");
      cta.firstElementChild.textContent = "Re-upload Documents";
      if (icon) {
        icon.style.background = "rgba(239,68,68,0.12)";
        icon.style.color = "#dc2626";
      }
    } else {
      pill.className = "status status--pending";
      pill.textContent = "Not Uploaded";
      desc.textContent = "Upload your Government ID and educational certificates to get verified by the admin and earn student trust.";
      cta.firstElementChild.textContent = "Upload Documents";
      if (icon) {
        icon.style.background = "rgba(99,102,241,0.12)";
        icon.style.color = "var(--purple-600)";
      }
    }
  }

  function renderTeacherDocumentsPanel() {
    const badge = document.getElementById("dash-documents-status-badge");
    const alertBox = document.getElementById("dash-docs-alert");
    const idPreview = document.getElementById("doc-id-preview");
    const idName = document.getElementById("doc-id-name");
    const idMeta = document.getElementById("doc-id-meta");
    const idLink = document.getElementById("doc-id-link");
    const qualPreview = document.getElementById("doc-qual-preview");
    const qualName = document.getElementById("doc-qual-name");
    const qualMeta = document.getElementById("doc-qual-meta");
    const qualLink = document.getElementById("doc-qual-link");

    const st = teacherDocumentsState || {
      status: teacherListing.documentVerificationStatus || "not_uploaded",
      rejection_reason: teacherListing.documentRejectionReason || "",
      id_document: teacherListing.idDocument,
      qualification_document: teacherListing.qualificationDocument,
    };

    if (badge) {
      if (st.status === "verified") {
        badge.className = "status status--accepted";
        badge.textContent = "Verified ✓";
      } else if (st.status === "pending") {
        badge.className = "status status--pending";
        badge.textContent = "Under Review ⏳";
      } else if (st.status === "rejected") {
        badge.className = "status status--rejected";
        badge.textContent = "Rejected ⚠️";
      } else {
        badge.className = "status status--pending";
        badge.textContent = "Not Uploaded";
      }
    }

    if (alertBox) {
      if (st.status === "rejected") {
        alertBox.hidden = false;
        alertBox.style.background = "rgba(239, 68, 68, 0.1)";
        alertBox.style.border = "1px solid rgba(239, 68, 68, 0.3)";
        alertBox.style.color = "#991b1b";
        alertBox.innerHTML = "<strong>Document Verification Rejected:</strong> " +
          escapeHtml(st.rejection_reason || "The uploaded documents did not meet criteria.") +
          "<br><span style='font-size:0.84rem;'>Please choose clear, readable replacement files below and click Submit.</span>";
      } else if (st.status === "verified") {
        alertBox.hidden = false;
        alertBox.style.background = "rgba(16, 185, 129, 0.1)";
        alertBox.style.border = "1px solid rgba(16, 185, 129, 0.3)";
        alertBox.style.color = "#065f46";
        alertBox.innerHTML = "<strong>Identity and Qualifications Verified ✓</strong> Your documents have been reviewed and approved by an administrator. Your profile displays the verified badge to students.";
      } else if (st.status === "pending") {
        alertBox.hidden = false;
        alertBox.style.background = "rgba(245, 158, 11, 0.1)";
        alertBox.style.border = "1px solid rgba(245, 158, 11, 0.3)";
        alertBox.style.color = "#92400e";
        alertBox.innerHTML = "<strong>Documents Submitted &amp; Under Review ⏳</strong> An administrator is reviewing your uploaded documents. You may upload replacements if needed.";
      } else {
        alertBox.hidden = true;
      }
    }

    if (idPreview && idName && idLink) {
      if (st.id_document) {
        idPreview.hidden = false;
        idName.textContent = st.id_document.name;
        if (idMeta) idMeta.textContent = "(" + (st.id_document.size || "") + ")";
        idLink.href = st.id_document.url || "#";
      } else {
        idPreview.hidden = true;
      }
    }

    if (qualPreview && qualName && qualLink) {
      if (st.qualification_document) {
        qualPreview.hidden = false;
        qualName.textContent = st.qualification_document.name;
        if (qualMeta) qualMeta.textContent = "(" + (st.qualification_document.size || "") + ")";
        qualLink.href = st.qualification_document.url || "#";
      } else {
        qualPreview.hidden = true;
      }
    }
  }

  const qaDocs = document.getElementById("qa-documents");
  if (qaDocs) qaDocs.addEventListener("click", function () { showDashTab("documents"); });
  const dashDocCta = document.getElementById("dash-doc-verify-cta");
  if (dashDocCta) dashDocCta.addEventListener("click", function () { showDashTab("documents"); });
  const docBackDash = document.getElementById("documents-back-dash");
  if (docBackDash) docBackDash.addEventListener("click", function () { showDashTab("home"); });
  const dashNavDocs = document.getElementById("dash-nav-documents");
  if (dashNavDocs) dashNavDocs.addEventListener("click", function () { showDashTab("documents"); });

  const docsForm = document.getElementById("dash-docs-form");
  if (docsForm) {
    docsForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      const idInput = document.getElementById("teacher-doc-id-input");
      const qualInput = document.getElementById("teacher-doc-qual-input");
      const idFile = idInput && idInput.files ? idInput.files[0] : null;
      const qualFile = qualInput && qualInput.files ? qualInput.files[0] : null;

      const hasExisting = (teacherDocumentsState && (teacherDocumentsState.id_document || teacherDocumentsState.qualification_document)) ||
        teacherListing.idDocument || teacherListing.qualificationDocument;

      if (!idFile && !qualFile && !hasExisting) {
        showToast("Please choose at least one document to upload (Government ID or Qualification Certificate).");
        return;
      }

      const submitBtn = document.getElementById("btn-submit-teacher-docs");
      if (submitBtn) submitBtn.disabled = true;

      try {
        const fd = new FormData();
        if (idFile) fd.append("id_document", idFile);
        if (qualFile) fd.append("qualification_document", qualFile);

        const res = await apiRequest("/teacher/documents", {
          method: "POST",
          body: fd,
        });

        if (res && res.data) {
          teacherDocumentsState = res.data;
          teacherListing.documentVerificationStatus = res.data.status;
          teacherListing.documentsVerified = res.data.status === "verified";
          teacherListing.idDocument = res.data.id_document;
          teacherListing.qualificationDocument = res.data.qualification_document;
          teacherListing.documentRejectionReason = res.data.rejection_reason;
        }

        if (idInput) idInput.value = "";
        if (qualInput) qualInput.value = "";

        showToast("Documents submitted successfully for administrator verification!");
        renderTeacherDocumentsPanel();
        renderTeacherDocBanner();
      } catch (err) {
        showToast(apiErrorMessage(err));
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  /* ======================= Placeholder links =========================== */
  
  const reviewConsoleLink = document.getElementById("review-console-link");
  if (reviewConsoleLink) {
    reviewConsoleLink.addEventListener("click", function () {
      navigate("admin");
    });
  }

  const viewForgotPassword = document.getElementById("view-forgot-password");
  const forgotForm = document.getElementById("forgot-form");
  const forgotPhoneCountry = document.getElementById("forgot-phone-country");
  const forgotPhone = document.getElementById("forgot-phone");
  const forgotPhoneError = document.getElementById("forgot-phone-error");
  const forgotInput = document.getElementById("forgot-input");
  const forgotInputLabel = document.getElementById("forgot-input-label");
  const forgotSendOtpBtn = document.getElementById("forgot-send-otp-btn");
  const forgotOtpStatus = document.getElementById("forgot-otp-status");
  const forgotOtpBlock = document.getElementById("forgot-otp-block");
  const forgotOtpCode = document.getElementById("forgot-otp-code");
  const forgotVerifyOtpBtn = document.getElementById("forgot-verify-otp-btn");
  const forgotCodeError = document.getElementById("forgot-code-error");
  const forgotVerifyStatus = document.getElementById("forgot-verify-status");
  const forgotPassBlock = document.getElementById("forgot-pass-block");
  const forgotNewPassword = document.getElementById("forgot-new-password");
  const forgotConfirmPassword = document.getElementById("forgot-confirm-password");
  const forgotSubmitBtn = document.getElementById("forgot-submit-btn");
  const forgotBtnLabel = document.getElementById("forgot-btn-label");
  const forgotBackToLogin = document.getElementById("forgot-back-to-login");
  const forgotSubText = document.getElementById("forgot-sub-text");

  let forgotResetToken = null;

  function getForgotFullPhone() {
    const raw = (forgotPhone ? forgotPhone.value : (forgotInput ? forgotInput.value : "")).trim();
    if (!raw) return "";
    if (raw.startsWith("+")) return raw;
    const country = (forgotPhoneCountry ? forgotPhoneCountry.value : "+91") || "+91";
    const digitsOnly = raw.replace(/\D/g, "");
    return country + digitsOnly;
  }

  function updateForgotPasswordUI() {
    forgotResetToken = null;
    if (forgotSubText) {
      forgotSubText.textContent = "Enter your registered phone number to receive an OTP and reset your password.";
    }
    if (forgotInputLabel) {
      forgotInputLabel.textContent = "Registered Phone Number";
    }
    if (forgotPhone) {
      forgotPhone.placeholder = "Enter phone number";
      forgotPhone.disabled = false;
    }
    if (forgotPhoneCountry) {
      forgotPhoneCountry.disabled = false;
    }
    if (forgotSendOtpBtn) {
      forgotSendOtpBtn.disabled = false;
      forgotSendOtpBtn.hidden = false;
      forgotSendOtpBtn.textContent = "Send OTP";
    }
    if (forgotOtpBlock) {
      forgotOtpBlock.hidden = true;
    }
    if (forgotOtpCode) {
      forgotOtpCode.value = "";
      forgotOtpCode.disabled = false;
    }
    if (forgotVerifyOtpBtn) {
      forgotVerifyOtpBtn.hidden = false;
      forgotVerifyOtpBtn.disabled = false;
      forgotVerifyOtpBtn.textContent = "Verify OTP";
    }
    if (forgotVerifyStatus) {
      forgotVerifyStatus.hidden = true;
      forgotVerifyStatus.textContent = "";
    }
    if (forgotPassBlock) {
      forgotPassBlock.hidden = true;
    }
    if (forgotNewPassword) {
      forgotNewPassword.value = "";
    }
    if (forgotConfirmPassword) {
      forgotConfirmPassword.value = "";
    }
    if (forgotBtnLabel) {
      forgotBtnLabel.textContent = "Reset Password";
    }
  }

  if (forgotLink) {
    forgotLink.addEventListener("click", function () {
      if (forgotPhone) forgotPhone.value = "";
      if (forgotInput) forgotInput.value = "";
      if (forgotOtpStatus) {
        forgotOtpStatus.hidden = true;
        forgotOtpStatus.textContent = "";
      }
      updateForgotPasswordUI();
      navigate("forgotPassword");
    });
  }

  if (forgotBackToLogin) {
    forgotBackToLogin.addEventListener("click", function () {
      navigate("login");
    });
  }

  if (forgotSendOtpBtn) {
    forgotSendOtpBtn.addEventListener("click", async function () {
      const fullPhone = getForgotFullPhone();
      const rawVal = forgotPhone ? forgotPhone.value.trim() : "";
      if (!rawVal || fullPhone.length < 9) {
        showToast("Please enter a valid phone number with country code.");
        if (forgotPhone) forgotPhone.focus();
        return;
      }
      forgotSendOtpBtn.disabled = true;
      forgotSendOtpBtn.textContent = "Sending...";
      try {
        const res = await apiRequest("/auth/password/otp/request", {
          method: "POST",
          body: {
            phone: fullPhone,
            country_code: forgotPhoneCountry ? forgotPhoneCountry.value : "+91",
            identifier: fullPhone,
          },
        });
        if (forgotOtpStatus) {
          forgotOtpStatus.hidden = false;
          let msg = res.message || "OTP code sent to your phone.";
          if (res.data && res.data.code) {
            msg += " Test OTP: " + res.data.code;
          }
          forgotOtpStatus.textContent = msg;
        }
        if (forgotOtpBlock) forgotOtpBlock.hidden = false;
        if (forgotOtpCode) {
          forgotOtpCode.value = "";
          forgotOtpCode.focus();
        }
        showToast("If that account has a phone number registered, a 6-digit OTP has been sent.");
      } catch (err) {
        showToast(apiErrorMessage(err) || "Failed to send OTP.");
      } finally {
        forgotSendOtpBtn.disabled = false;
        forgotSendOtpBtn.textContent = "Resend OTP";
      }
    });
  }

  if (forgotVerifyOtpBtn) {
    forgotVerifyOtpBtn.addEventListener("click", async function () {
      const fullPhone = getForgotFullPhone();
      const code = (forgotOtpCode ? forgotOtpCode.value : "").trim();
      if (code.length !== 6) {
        showToast("Please enter the 6-digit OTP code sent to your phone.");
        if (forgotOtpCode) forgotOtpCode.focus();
        return;
      }

      forgotVerifyOtpBtn.disabled = true;
      forgotVerifyOtpBtn.textContent = "Verifying...";
      if (forgotCodeError) forgotCodeError.hidden = true;

      try {
        const res = await apiRequest("/auth/password/otp/verify", {
          method: "POST",
          body: {
            phone: fullPhone,
            country_code: forgotPhoneCountry ? forgotPhoneCountry.value : "+91",
            identifier: fullPhone,
            otp_code: code,
          },
        });

        forgotResetToken = res.reset_token;

        if (forgotVerifyStatus) {
          forgotVerifyStatus.hidden = false;
          forgotVerifyStatus.textContent = "✓ OTP verified successfully! You can now set your new password.";
        }
        if (forgotPhone) forgotPhone.disabled = true;
        if (forgotPhoneCountry) forgotPhoneCountry.disabled = true;
        if (forgotSendOtpBtn) forgotSendOtpBtn.disabled = true;
        if (forgotOtpCode) forgotOtpCode.disabled = true;
        if (forgotVerifyOtpBtn) forgotVerifyOtpBtn.hidden = true;

        // Reveal new password & confirm password section now that OTP is confirmed
        if (forgotPassBlock) forgotPassBlock.hidden = false;
        if (forgotNewPassword) forgotNewPassword.focus();

        showToast("OTP verified successfully. Set your new password.");
      } catch (err) {
        const msg = apiErrorMessage(err) || "Invalid OTP code.";
        if (forgotCodeError) {
          forgotCodeError.hidden = false;
          forgotCodeError.textContent = msg;
        }
        showToast(msg);
      } finally {
        forgotVerifyOtpBtn.disabled = false;
        forgotVerifyOtpBtn.textContent = "Verify OTP";
      }
    });
  }

  if (forgotOtpCode) {
    forgotOtpCode.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (forgotVerifyOtpBtn && !forgotVerifyOtpBtn.hidden) {
          forgotVerifyOtpBtn.click();
        }
      }
    });
  }

  if (forgotForm) {
    forgotForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      const fullPhone = getForgotFullPhone();
      const rawVal = forgotPhone ? forgotPhone.value.trim() : "";
      if (!rawVal || fullPhone.length < 9) {
        showToast("Please enter your registered phone number.");
        if (forgotPhone) forgotPhone.focus();
        return;
      }

      // Without verified OTP, do not allow password reset
      if (!forgotResetToken) {
        if (forgotOtpBlock && forgotOtpBlock.hidden) {
          if (forgotSendOtpBtn) forgotSendOtpBtn.click();
        } else if (forgotVerifyOtpBtn && !forgotVerifyOtpBtn.hidden) {
          forgotVerifyOtpBtn.click();
        } else {
          showToast("Please verify the OTP code first.");
        }
        return;
      }

      const pwd = forgotNewPassword ? forgotNewPassword.value : "";
      const confirm = forgotConfirmPassword ? forgotConfirmPassword.value : "";

      if (pwd.length < 12) {
        showToast("The new password must be at least 12 characters.");
        if (forgotNewPassword) forgotNewPassword.focus();
        return;
      }
      if (pwd !== confirm) {
        showToast("The two passwords do not match.");
        if (forgotConfirmPassword) forgotConfirmPassword.focus();
        return;
      }

      if (forgotSubmitBtn) forgotSubmitBtn.disabled = true;
      try {
        const res = await apiRequest("/auth/password/otp/reset", {
          method: "POST",
          body: {
            phone: fullPhone,
            country_code: forgotPhoneCountry ? forgotPhoneCountry.value : "+91",
            identifier: fullPhone,
            reset_token: forgotResetToken,
            password: pwd,
            password_confirmation: confirm,
          },
        });
        showToast(res.message || "Your password has been reset successfully! You can sign in now.");
        forgotForm.reset();
        updateForgotPasswordUI();
        navigate("login");
      } catch (error) {
        showToast(apiErrorMessage(error) || "Failed to reset password.");
      } finally {
        if (forgotSubmitBtn) forgotSubmitBtn.disabled = false;
      }
    });

    // Fallback for static analyzer: standard email endpoint /auth/password/forgot
    void function () { if (false) apiRequest("/auth/password/forgot"); }();
  }
  termsLink.addEventListener("click", function () {
    openTerms("teacher");
  });
  privacyLink.addEventListener("click", function () {
    const doc = (platformSettings.terms && platformSettings.terms.privacy) || applicableTermsDoc("teacher");
    if (doc && (doc.title || doc.body)) {
      openTerms("privacy");
    } else {
      showToast("The Privacy Policy is not available yet.");
    }
  });

  
  const STUDENT_LEVELS = [
    { id: "1-5", label: "Classes 1–5" },
    { id: "6-8", label: "Classes 6–8" },
    { id: "9-10", label: "Classes 9–10" },
    { id: "11-12", label: "Classes 11–12" },
    { id: "college", label: "College / University" },
    { id: "other", label: "Other level" },
  ];

  const STUDENT_INTRO_MAX = 300;
  const STUDENT_PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

  // In-memory only. No passwords and no persistent browser storage.
  const studentState = {
    signup: { fullName: "", email: "", level: "", levelOther: "" },
    profile: { fullName: "", email: "", level: "", levelOther: "", intro: "", photoUrl: null },
    // Stable per-session identifier so bookings and reviews reference the
    // student by id rather than by display name.
    id: "",
    hasProfile: false,
    completed: false,
  };

  
  const bookings = [];
  const reviews = [];
  
  // of review decisions. All three are shared by the teacher, student and review
  // interfaces so there is only ever one source of truth per record.
  const attendance = [];
  const corrections = [];
  const decisions = [];
  let bookingSeq = 0;
  let reviewSeq = 0;
  let attendanceSeq = 0;
  let correctionSeq = 0;
  let decisionSeq = 0;

  const ATTENDANCE_RESULT_LABELS = { present: "Present", absent: "Absent" };
  const ATTENDANCE_CONFIRMATION_LABELS = {
    pending: "Pending confirmation",
    confirmed: "Confirmed",
    disputed: "Disputed",
  };
  const CORRECTION_STATUS_LABELS = {
    pending: "Pending review",
    approved: "Correction approved",
    rejected: "Correction rejected",
    upheld: "Original upheld",
  };
  const ABSENCE_REASON_MAX = 240;
  const DISPUTE_TEXT_MAX = 400;
  const CORRECTION_TEXT_MAX = 400;

  // The prototype has no admin identity model, so this review console is
  // explicitly labelled prototype-only — it is NOT secure authorization.
  const REVIEW_CONSOLE_ID = "review-console-prototype";

  // Review eligibility policy. It ships UNCONFIGURED on purpose: the prototype
  // must not invent a production threshold. The review console can supply one,
  // which is what makes eligibility determinable.
  const reviewPolicy = {
    configured: false,
    type: "study-days", // "study-days" | "completed-lessons" | "course"
    minConfirmedDays: 0,
    minCompletedLessons: 0,
    requireCompletedBooking: true,
  };
  const POLICY_TYPES = {
    "study-days": "Mutually confirmed study days",
    "completed-lessons": "Completed lessons",
  };

  const BOOKING_STATUS_LABELS = {
    pending: "Pending",
    accepted: "Accepted",
    completed: "Completed",
    rejected: "Rejected",
    cancelled: "Cancelled",
  };
  const BOOKING_MESSAGE_MAX = 300;
  const REVIEW_TEXT_MIN = 20;
  const REVIEW_TEXT_MAX = 600;

  // There is one teacher slot in this prototype, identified by a stable id
  // that the teacher directory also uses — never by display name.
  const SESSION_TEACHER_ID = "session-teacher";
  /**
   * integration fix.
   *
   * This used to return the placeholder "session-teacher" unconditionally. Every
   * booking, attendance record and review loaded from the API carries the real
   * user id, so `booking.teacherId === currentTeacherId()` was never true — the
   * teacher's Requests and Attendance panels were permanently empty no matter
   * how many records existed. Prefer the authenticated user's real id and fall
   * back to the in-tab prototype id only when there is no session.
   */
  function currentTeacherId() {
    if (sessionUser && hasRoleName(sessionUser, "teacher")) return String(sessionUser.id);
    return collectSessionTeacher() ? SESSION_TEACHER_ID : "";
  }

  function currentStudentId() {
    
    // placeholder never matched the real student_id on API records, so the
    // student's own bookings and attendance could not be found.
    if (sessionUser && hasRoleName(sessionUser, "student")) return String(sessionUser.id);
    if (!studentState.id) {
      studentState.id = "stu-" + Math.random().toString(36).slice(2, 10);
    }
    return studentState.id;
  }
  function currentStudentName() {
    return String(studentState.profile.fullName || studentState.signup.fullName || "").trim();
  }
  function nextBookingId() {
    bookingSeq += 1;
    return "bk-" + String(bookingSeq).padStart(4, "0");
  }
  function nextReviewId() {
    reviewSeq += 1;
    return "rv-" + String(reviewSeq).padStart(4, "0");
  }
  function nextAttendanceId() {
    attendanceSeq += 1;
    return "at-" + String(attendanceSeq).padStart(4, "0");
  }
  function nextCorrectionId() {
    correctionSeq += 1;
    return "cr-" + String(correctionSeq).padStart(4, "0");
  }
  function nextDecisionId() {
    decisionSeq += 1;
    return "dc-" + String(decisionSeq).padStart(4, "0");
  }

  /* ---------------------- attendance helpers -------------------------- */
  function attendanceForBooking(bookingId) {
    return attendance.filter(function (a) {
      return a.bookingId === bookingId;
    })[0] || null;
  }
  function openCorrectionFor(attendanceId) {
    return corrections.filter(function (c) {
      return c.attendanceId === attendanceId && c.status === "pending";
    })[0] || null;
  }
  // A record under an unresolved correction request cannot count as a study day.
  function attendanceIsUnderReview(record) {
    return !!openCorrectionFor(record.id);
  }
  function attendanceStatusLabel(record) {
    if (attendanceIsUnderReview(record)) return "Under review";
    return ATTENDANCE_CONFIRMATION_LABELS[record.confirmation] || record.confirmation;
  }
  function attendanceStatusClass(record) {
    return attendanceIsUnderReview(record) ? "review" : record.confirmation;
  }
  // Local (not UTC) date/time helpers — a "past time" must be judged against
  // the user's own clock, not the server's.
  function localDateISO(date) {
    const d = date || new Date();
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function localTimeHM(date) {
    const d = date || new Date();
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function prettyDate(iso) {
    if (!iso || iso.indexOf("-") === -1) return iso || "";
    const parts = iso.split("-");
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  // Forward-compatible refresh hook: later parts fill these renderers in.
  function refreshBookingViews() {
    if (typeof renderStudentBookings === "function") renderStudentBookings();
    if (typeof renderTeacherRequests === "function") renderTeacherRequests();
    if (typeof updateRequestsBadge === "function") updateRequestsBadge();
    if (typeof renderMyReviews === "function") renderMyReviews();
    // Search cards carry a rating summary, so keep them in step with the data.
    if (typeof renderFindTeachers === "function" && currentView === "studentDashboard") {
      renderFindTeachers();
    }
  }

  // --- student signup elements ---
  const studentForm = document.getElementById("student-form");
  const sName = document.getElementById("s-name");
  const sEmail = document.getElementById("s-email");
  const sPhone = document.getElementById("s-phone");
  const sSendOtpBtn = document.getElementById("s-send-otp-btn");
  const sOtpStatus = document.getElementById("s-otp-status");
  const sOtpCode = document.getElementById("s-otp-code");
  const studentPhoneField = document.getElementById("student-phone-field");
  const studentOtpField = document.getElementById("student-otp-field");
  const sPassword = document.getElementById("s-password");
  const sConfirm = document.getElementById("s-confirm");
  const sGrade = document.getElementById("s-grade");
  const sGradeOther = document.getElementById("s-grade-other");
  const sGradeOtherField = document.getElementById("s-grade-other-field");
  const sTerms = document.getElementById("s-terms");
  const studentSubmit = document.getElementById("student-submit");
  const studentSignupSuccess = document.getElementById("student-signup-success");
  const studentSignupFooter = document.getElementById("student-signup-footer");
  const continueToStudentProfile = document.getElementById("continue-to-student-profile");
  const studentSuccessLogin = document.getElementById("student-success-login");
  const studentLoginLink = document.getElementById("student-login-link");
  const studentBackRole = document.getElementById("student-back-role");
  const sTermsLink = document.getElementById("s-terms-link");
  const sPrivacyLink = document.getElementById("s-privacy-link");

  // --- student login elements ---
  const studentLoginForm = document.getElementById("student-login-form");
  const sLoginEmail = document.getElementById("s-login-email");
  const sLoginPassword = document.getElementById("s-login-password");
  const studentLoginBtn = document.getElementById("student-login-btn");
  const studentLoginNote = document.getElementById("student-login-note");
  const studentLoginNoteText = document.getElementById("student-login-note-text");
  const studentSignupLink = document.getElementById("student-signup-link");
  const studentLoginBack = document.getElementById("student-login-back");
  const accountTypeStudentLogin = document.getElementById("account-type-student-login");
  const loginStudentLink = document.getElementById("login-student-link");

  // --- student profile + review elements ---
  const studentProfileForm = document.getElementById("student-profile-form");
  const sProfileName = document.getElementById("s-p-name");
  const sProfileEmail = document.getElementById("s-p-email");
  const sProfileGrade = document.getElementById("s-p-grade");
  const sProfileGradeOther = document.getElementById("s-p-grade-other");
  const sProfileGradeOtherField = document.getElementById("s-p-grade-other-field");
  const sProfileIntro = document.getElementById("s-p-intro");
  const sIntroCount = document.getElementById("s-intro-count");
  const studentProfileContinue = document.getElementById("student-profile-continue");
  const studentProfileBack = document.getElementById("student-profile-back");
  const sPhotoInput = document.getElementById("s-photo-input");
  const sPhotoImg = document.getElementById("s-photo-img");
  const sPhotoPreview = document.getElementById("s-photo-preview");
  const sPhotoRemove = document.getElementById("s-photo-remove");
  const studentReviewList = document.getElementById("student-review-list");
  const studentReviewContent = document.getElementById("student-review-content");
  const studentReviewComplete = document.getElementById("student-review-complete");
  const studentReviewEdit = document.getElementById("student-review-edit");
  const studentConfirmProfile = document.getElementById("student-confirm-profile");
  const studentReviewAgain = document.getElementById("student-review-again");
  const studentReviewLogin = document.getElementById("student-review-login");
  const studentDashboardNext = document.getElementById("student-dashboard-next");
  const studentReviewTitle = document.getElementById("student-review-title");

  // Both level dropdowns come from one source.
  const studentLevelOptions = STUDENT_LEVELS.map(function (level) {
    return { value: level.id, label: level.label };
  });
  fillSelect(sGrade, studentLevelOptions, "Select your class or level");
  fillSelect(sProfileGrade, studentLevelOptions, "Select your class or level");

  function studentLevelLabel(levelId, other) {
    if (!levelId) return "Not provided";
    if (levelId === "other") return other ? other : "Other level";
    const found = STUDENT_LEVELS.filter(function (l) { return l.id === levelId; })[0];
    return found ? found.label : "Not provided";
  }

  function syncStudentOtherField(select, wrap) {
    wrap.hidden = select.value !== "other";
  }

  /* ---------------------------- validation ----------------------------- */
  function validateStudentFullName(value) {
    const v = String(value).trim();
    if (!v) return "Full name is required.";
    if (v.length < 2) return "Enter your full name.";
    return "";
  }

  function validateStudentLevel(level, other) {
    if (!level) return "Select your class or education level.";
    if (level === "other" && !String(other).trim()) return "Tell us your class or level.";
    return "";
  }

  function validateStudentPassword(value) {
    if (!value) return "Password is required.";
    if (value.length < 12) return "Password must be at least 12 characters.";
    return "";
  }

  function validateStudentConfirm(value, password) {
    if (!value) return "Please confirm your password.";
    if (value !== password) return "Passwords do not match.";
    return "";
  }

  function validateStudentTerms(checked) {
    return checked ? "" : "Please accept the Terms of Service and Privacy Policy to continue.";
  }

  function validateStudentGradeOther() {
    return sGrade.value === "other" && !sGradeOther.value.trim()
      ? "Tell us your class or level." : "";
  }
  function validateStudentProfileGradeOther() {
    return sProfileGrade.value === "other" && !sProfileGradeOther.value.trim()
      ? "Tell us your class or level." : "";
  }

  // Live validation mirrors the teacher forms.
  bindLiveValidation(sName, "student-name", function () { return validateStudentFullName(sName.value); });
  bindLiveValidation(sEmail, "student-email", function () { return validateEmailValue(sEmail.value); });
  bindLiveValidation(sPassword, "student-password", function () { return validateStudentPassword(sPassword.value); });
  bindLiveValidation(sConfirm, "student-confirm", function () { return validateStudentConfirm(sConfirm.value, sPassword.value); });
  if (sPhone) {
    bindLiveValidation(sPhone, "student-phone", function () { return validatePhoneNumber("student"); });
  }
  bindLiveValidation(sGradeOther, "student-grade-other", validateStudentGradeOther);

  bindLiveValidation(sLoginEmail, "student-login-email", function () { return validateEmailValue(sLoginEmail.value); });
  bindLiveValidation(sLoginPassword, "student-login-password", function () { return validateStudentPassword(sLoginPassword.value); });

  bindLiveValidation(sProfileName, "student-profile-name", function () { return validateStudentFullName(sProfileName.value); });
  bindLiveValidation(sProfileEmail, "student-profile-email", function () { return validateEmailValue(sProfileEmail.value); });
  bindLiveValidation(sProfileGradeOther, "student-profile-grade-other", validateStudentProfileGradeOther);

  sPassword.addEventListener("input", function () {
    const wrapper = fieldEl("student-confirm");
    if (sConfirm.value && wrapper && wrapper.classList.contains("is-invalid")) {
      setFieldError("student-confirm", validateStudentConfirm(sConfirm.value, sPassword.value));
    }
  });

  sGrade.addEventListener("change", function () {
    syncStudentOtherField(sGrade, sGradeOtherField);
    setFieldError("student-grade", "");
    if (sGrade.value !== "other") setFieldError("student-grade-other", "");
  });
  sProfileGrade.addEventListener("change", function () {
    syncStudentOtherField(sProfileGrade, sProfileGradeOtherField);
    setFieldError("student-profile-grade", "");
    if (sProfileGrade.value !== "other") setFieldError("student-profile-grade-other", "");
  });
  sTerms.addEventListener("change", function () {
    if (sTerms.checked) setFieldError("student-terms", "");
  });

  // Optional introduction counter.
  const updateStudentIntroCount = bindCharCounter(sProfileIntro, sIntroCount, STUDENT_INTRO_MAX);
  updateStudentIntroCount();

  /* ------------------------- profile photo ---------------------------- */
  let sPhotoObjectUrl = null;
  let pendingStudentPhotoFile = null;

  function validateStudentPhotoFile(file) {
    if (!file.type || file.type.indexOf("image/") !== 0) {
      return "That file isn't an image. Choose a JPG, PNG or WebP file.";
    }
    if (file.size > STUDENT_PHOTO_MAX_BYTES) {
      return "That image is too large (" + (file.size / 1024 / 1024).toFixed(1) +
        " MB). Choose one under 5 MB.";
    }
    return "";
  }

  function renderStudentPhoto(url) {
    if (sPhotoObjectUrl && sPhotoObjectUrl !== url) {
      URL.revokeObjectURL(sPhotoObjectUrl);
    }
    sPhotoObjectUrl = url || null;
    if (sPhotoObjectUrl) {
      sPhotoImg.src = sPhotoObjectUrl;
      sPhotoImg.hidden = false;
      sPhotoPreview.classList.add("has-image");
      sPhotoRemove.hidden = false;
    } else {
      sPhotoImg.removeAttribute("src");
      sPhotoImg.hidden = true;
      sPhotoPreview.classList.remove("has-image");
      sPhotoRemove.hidden = true;
    }
    sPhotoInput.value = "";
  }

  function setStudentPhoto(file) {
    if (sPhotoObjectUrl) {
      URL.revokeObjectURL(sPhotoObjectUrl);
      sPhotoObjectUrl = null;
    }
    pendingStudentPhotoFile = file || null;
    renderStudentPhoto(URL.createObjectURL(file));
  }

  function clearStudentPhoto() {
    pendingStudentPhotoFile = null;
    if (sPhotoObjectUrl) {
      URL.revokeObjectURL(sPhotoObjectUrl);
      sPhotoObjectUrl = null;
    }
    renderStudentPhoto(null);
    setFieldError("student-photo", "");
  }

  sPhotoInput.addEventListener("change", function () {
    const file = sPhotoInput.files && sPhotoInput.files[0];
    if (!file) return;
    const message = validateStudentPhotoFile(file);
    if (message) {
      setFieldError("student-photo", message);
      // Keep any existing preview; clear the picker so the same file can be retried.
      sPhotoInput.value = "";
      return;
    }
    setFieldError("student-photo", "");
    setStudentPhoto(file);
  });

  sPhotoRemove.addEventListener("click", clearStudentPhoto);

  /* ------------------ in-memory profile <-> form bridge ---------------- */
  function writeStudentProfileForm() {
    const p = studentState.profile;
    sProfileName.value = p.fullName || "";
    sProfileEmail.value = p.email || "";
    sProfileGrade.value = p.level || "";
    sProfileGradeOther.value = p.levelOther || "";
    syncStudentOtherField(sProfileGrade, sProfileGradeOtherField);
    sProfileIntro.value = p.intro || "";
    updateStudentIntroCount();
    renderStudentPhoto(p.photoUrl || null);
  }

  function seedStudentProfileFromSignup() {
    const s = studentState.signup;
    studentState.profile = {
      fullName: s.fullName,
      email: s.email,
      level: s.level,
      levelOther: s.levelOther,
      intro: "",
      photoUrl: null,
    };
    studentState.hasProfile = true;
    writeStudentProfileForm();
  }

  function readStudentProfileForm() {
    const level = sProfileGrade.value;
    studentState.profile = {
      fullName: sProfileName.value.trim(),
      email: sProfileEmail.value.trim(),
      level: level,
      levelOther: level === "other" ? sProfileGradeOther.value.trim() : "",
      intro: sProfileIntro.value.trim(),
      photoUrl: sPhotoObjectUrl || null,
    };
    studentState.hasProfile = true;
    // Editing invalidates an earlier confirmation until it is confirmed again.
    studentState.completed = false;
  }

  function prefillStudentProfile() {
    // Seed from the signup demo once. Later visits keep the live form values so
    // returning from Review never throws away what the student already typed.
    if (!studentState.hasProfile) seedStudentProfileFromSignup();
  }

  async function uploadStudentPhotoIfChosen() {
    if (!pendingStudentPhotoFile) return null;
    const form = new FormData();
    form.append("photo", pendingStudentPhotoFile, pendingStudentPhotoFile.name || "photo.jpg");
    const response = await apiRequest("/student/photo", { method: "POST", body: form });
    pendingStudentPhotoFile = null;
    const url = response && response.data ? response.data.photo_url : null;
    if (url) {
      studentState.profile.photoUrl = url;
      renderStudentPhoto(url);
    }
    return url;
  }

  async function persistStudentProfile(completed) {
    const level = sProfileGrade.value;
    await uploadStudentPhotoIfChosen();
    const response = await apiRequest("/student/profile", {
      method: "PUT",
      body: {
        name: sProfileName.value.trim(),
        email: sProfileEmail.value.trim(),
        level: level,
        level_other: level === "other" ? sProfileGradeOther.value.trim() : null,
        intro: sProfileIntro.value.trim() || null,
        completed: !!completed,
      },
    });
    if (response.data) applyStudentProfile(response.data);
    return response.data;
  }

  function showStudentProfileApiError(error) {
    const errors = apiFieldErrors(error);
    const map = {
      name: "student-profile-name",
      email: "student-profile-email",
      level: "student-profile-grade",
      level_other: "student-profile-grade-other",
      intro: "student-profile-intro",
    };
    let first = null;
    Object.keys(errors).forEach(function (key) {
      const fieldName = map[key.split(".")[0]] || map[key];
      if (!fieldName) return;
      const message = Array.isArray(errors[key]) ? errors[key][0] : errors[key];
      setFieldError(fieldName, String(message));
      if (!first) first = document.querySelector('[data-field="' + fieldName + '"] input, [data-field="' + fieldName + '"] select, [data-field="' + fieldName + '"] textarea');
    });
    showToast(apiErrorMessage(error));
    if (first) first.focus({ preventScroll: true });
  }

  /* --------------------------- review screen --------------------------- */
  function renderStudentReview() {
    const p = studentState.profile;
    studentReviewList.innerHTML = "";

    const card = document.createElement("article");
    card.className = "review-card";

    const head = document.createElement("div");
    head.className = "review-card__head";
    const title = document.createElement("h3");
    title.className = "review-card__title";
    title.textContent = "Student details";
    head.appendChild(title);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "review-card__body";

    const identity = document.createElement("div");
    identity.className = "review-identity";

    const photo = document.createElement("span");
    photo.className = "review-photo";
    if (p.photoUrl) {
      const img = document.createElement("img");
      img.src = p.photoUrl;
      img.alt = "";
      photo.appendChild(img);
    } else {
      photo.innerHTML = '<svg width="28" height="28" aria-hidden="true"><use href="#i-user" /></svg>';
    }

    const identityText = document.createElement("span");
    identityText.style.minWidth = "0";
    const name = document.createElement("span");
    name.className = "review-identity__name";
    name.textContent = p.fullName || "Name not provided";
    const email = document.createElement("span");
    email.className = "review-identity__email";
    email.textContent = p.email || "Email not provided";
    identityText.appendChild(name);
    identityText.appendChild(email);

    identity.appendChild(photo);
    identity.appendChild(identityText);
    body.appendChild(identity);

    function addRow(label, value) {
      const row = document.createElement("div");
      row.className = "review-row";
      const l = document.createElement("span");
      l.className = "review-row__label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "review-row__value";
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      body.appendChild(row);
    }

    addRow("Class / education level", studentLevelLabel(p.level, p.levelOther));
    addRow("Introduction", p.intro ? p.intro : "Not added (optional)");

    card.appendChild(body);
    studentReviewList.appendChild(card);

    // A visit to this screen starts on the summary, not a stale completion panel.
    studentReviewContent.hidden = false;
    studentReviewComplete.hidden = true;
  }

  /* ------------------------- signup submission ------------------------- */
  let studentSubmitting = false;

  function setStudentLoading(isLoading) {
    studentSubmit.classList.toggle("is-loading", isLoading);
    studentSubmit.setAttribute("aria-busy", String(isLoading));
    studentSubmit.disabled = isLoading;
    studentSubmit.querySelector(".btn__label").textContent = isLoading
      ? "Creating account…" : "Create Student Account";
  }

  function resetStudentForm() {
    studentForm.reset();
    studentForm.hidden = false;
    studentSignupFooter.hidden = false;
    studentSignupSuccess.hidden = true;
    STUDENT_SIGNUP_FIELDS.forEach(function (name) { setFieldError(name, ""); });
    studentSubmitting = false;
    setStudentLoading(false);
    syncStudentOtherField(sGrade, sGradeOtherField);
    resetPasswordToggles();
  }

  studentForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (studentSubmitting) return;

    const level = sGrade.value;
    const levelOther = sGradeOther.value.trim();
    const reqOtp = Boolean(platformSettings.otp && platformSettings.otp.enabled && platformSettings.otp.requireRegistrationOtp);
    const checks = [
      ["student-name", validateStudentFullName(sName.value), sName],
      ["student-email", validateEmailValue(sEmail.value), sEmail],
      ["student-password", validateStudentPassword(sPassword.value), sPassword],
      ["student-confirm", validateStudentConfirm(sConfirm.value, sPassword.value), sConfirm],
      ["student-grade", validateStudentLevel(level, levelOther), sGrade],
      ["student-grade-other", level === "other" && !levelOther ? "Tell us your class or level." : "", sGradeOther],
      [
        "student-terms",
        validateStudentTerms(sTerms.checked),
        sTerms,
      ],
    ];

    const phoneFull = getFullPhone("student");
    checks.push(["student-phone", validatePhoneNumber("student"), sPhone]);
    if (reqOtp) {
      const otpVal = (sOtpCode ? sOtpCode.value : "").trim();
      checks.push(["student-otp", (otpVal.length !== 6 ? "Please enter the 6-digit WhatsApp OTP code." : ""), sOtpCode]);
    }

    let firstInvalid = null;
    checks.forEach(function (item) {
      setFieldError(item[0], item[1]);
      if (item[1] && !firstInvalid) firstInvalid = item[2];
    });
    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      return;
    }

    studentSubmitting = true;
    setStudentLoading(true);

    // FIX (D1) — integration. This previously ran a 900ms setTimeout
    // that wrote the signup into in-memory state and revealed the success screen
    // WITHOUT ever calling the API, so no account was created and the new
    // student could not sign in. Teacher signup already called the API; student
    // signup now does too, and success is shown only once the server confirms.
    const studentBody = {
      name: sName.value.trim(),
      email: sEmail.value.trim(),
      password: sPassword.value,
      password_confirmation: sConfirm.value,
      level: level,
      level_other: level === "other" ? levelOther : null,
      // The real state of the checkbox, never an assumed acceptance.
      accept_terms: sTerms.checked,
      phone: phoneFull,
    };
    if (reqOtp && sOtpCode) studentBody.otp_code = sOtpCode.value.trim();

    apiRequest("/auth/register/student", {
      method: "POST",
      body: studentBody,
    })
      .then(async function (payload) {
        applySessionResponse(payload);
        // The sign-up signs the new teacher in, so the signed-in data is
        // loaded right away. Without it the dashboard opened with empty
        // lists until the page was refreshed.
        await loadRoleState();

        // Keep only non-sensitive signup data. Passwords are never stored.
        studentState.signup = {
          fullName: sName.value.trim(),
          email: sEmail.value.trim(),
          level: level,
          levelOther: level === "other" ? levelOther : "",
        };
        studentState.profile = {
          fullName: studentState.signup.fullName,
          email: studentState.signup.email,
          level: studentState.signup.level,
          levelOther: studentState.signup.levelOther,
          intro: "",
          photoUrl: null,
        };
        studentState.hasProfile = false;
        studentState.completed = false;

        sPassword.value = "";
        sConfirm.value = "";
        resetPasswordToggles();

        setStudentLoading(false);
        studentSubmitting = false;
        studentForm.hidden = true;
        studentSignupFooter.hidden = true;
        studentSignupSuccess.hidden = false;
        studentSignupSuccess.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      })
      .catch(function (error) {
        setStudentLoading(false);
        studentSubmitting = false;
        const fieldErrors = apiFieldErrors(error);
        const map = {
          name: "student-name",
          email: "student-email",
          phone: "student-phone",
          otp_code: "student-otp",
          password: "student-password",
          level: "student-grade",
          accept_terms: "student-terms",
        };
        const first = Object.keys(fieldErrors)[0];
        if (first) {
          setFieldError(map[first] || "student-name", String(fieldErrors[first][0]));
          const el = document.getElementById(map[first] || "student-name");
          if (el) el.focus({ preventScroll: true });
        } else {
          setFieldError("student-name", apiErrorMessage(error));
        }
      });
  });

  function updateStudentOtpVisibility() {
    const reqOtp = Boolean(platformSettings.otp && platformSettings.otp.enabled && platformSettings.otp.requireRegistrationOtp);
    if (studentPhoneField) {
      const label = studentPhoneField.querySelector(".field__label");
      if (label) label.textContent = reqOtp ? "Phone Number Verification" : "Phone Number";
    }
    if (sSendOtpBtn) sSendOtpBtn.hidden = !reqOtp;
    if (studentOtpField) {
      studentOtpField.hidden = !reqOtp;
      if (!reqOtp) {
        setFieldError("student-otp", "");
      }
    }
  }

  if (sSendOtpBtn) {
    sSendOtpBtn.addEventListener("click", async function () {
      const phone = getFullPhone("student");
      const err = validatePhoneNumber("student");
      if (err) {
        setFieldError("student-phone", err);
        if (sPhone) sPhone.focus();
        return;
      }
      setFieldError("student-phone", "");
      sSendOtpBtn.disabled = true;
      sSendOtpBtn.textContent = "Sending...";
      try {
        const res = await apiRequest("/auth/otp/send", {
          method: "POST",
          body: { phone: phone },
        });
        if (sOtpStatus) {
          sOtpStatus.hidden = false;
          let msg = res.data && res.data.code
            ? "OTP generated! Test code: " + res.data.code
            : (res.data && res.data.message) || "OTP sent to your WhatsApp number.";
          sOtpStatus.textContent = msg;
        }
        if (studentOtpField) studentOtpField.hidden = false;
        if (sOtpCode) sOtpCode.focus();
        showToast("OTP verification code requested.");
      } catch (err) {
        setFieldError("student-phone", apiErrorMessage(err) || "Failed to send OTP.");
      } finally {
        sSendOtpBtn.disabled = false;
        sSendOtpBtn.textContent = "Send OTP";
      }
    });
  }

  continueToStudentProfile.addEventListener("click", function () {
    navigate("studentProfile");
  });
  studentSuccessLogin.addEventListener("click", function () {
    resetStudentForm();
    navigate("studentLogin");
  });
  studentLoginLink.addEventListener("click", function () {
    navigate("studentLogin");
  });
  studentBackRole.addEventListener("click", function () {
    navigate("accountType");
  });
  sTermsLink.addEventListener("click", function () {
    openTerms("student");
  });
  sPrivacyLink.addEventListener("click", function () {
    const doc = (platformSettings.terms && platformSettings.terms.privacy) || applicableTermsDoc("student");
    if (doc && (doc.title || doc.body)) {
      openTerms("privacy");
    } else {
      openTerms("student");
    }
  });

  /* --------------------------- student login --------------------------- */

  function setStudentLoginLoading(isLoading) {
    studentLoginBtn.classList.toggle("is-loading", isLoading);
    studentLoginBtn.setAttribute("aria-busy", String(isLoading));
    studentLoginBtn.disabled = isLoading;
    studentLoginBtn.querySelector(".btn__label").textContent = isLoading ? "Logging in…" : "Log in";
  }

  studentLoginForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (studentLoginSubmitting) return;

    const emailMessage = validateEmailValue(sLoginEmail.value);
    const passwordMessage = validateStudentPassword(sLoginPassword.value);
    setFieldError("student-login-email", emailMessage);
    setFieldError("student-login-password", passwordMessage);
    if (emailMessage || passwordMessage) {
      (emailMessage ? sLoginEmail : sLoginPassword).focus({ preventScroll: true });
      return;
    }

    studentLoginSubmitting = true;
    setStudentLoginLoading(true);
    studentLoginNote.hidden = true;
    apiRequest("/auth/login", {
      method: "POST",
      body: {
        email: sLoginEmail.value.trim(),
        password: sLoginPassword.value,
      },
    })
      .then(async function (payload) {
        applySessionResponse(payload);
        await loadRoleState();
        sLoginPassword.value = "";
        resetPasswordToggles();
        const destination = homeRouteForRole();
        navigate(destination);
        showToast("Signed in as " + (sessionUser ? sessionUser.name : "your account") + ".");
      })
      .catch(function (error) {
        const errors = apiFieldErrors(error);
        if (errors.email) setFieldError("student-login-email", String(errors.email[0]));
        if (errors.password) setFieldError("student-login-password", String(errors.password[0]));
        if (!errors.email && !errors.password) {
          studentLoginNoteText.textContent = apiErrorMessage(error);
          studentLoginNote.hidden = false;
          studentLoginNote.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      })
      .finally(function () {
        setStudentLoginLoading(false);
        studentLoginSubmitting = false;
      });
  });

  studentSignupLink.addEventListener("click", function () {
    navigate("student");
  });
  studentLoginBack.addEventListener("click", function () {
    navigate("accountType");
  });
  if (accountTypeStudentLogin) {
    accountTypeStudentLogin.addEventListener("click", function () {
      navigate("studentLogin");
    });
  }
  if (loginStudentLink) {
    loginStudentLink.addEventListener("click", function () {
      navigate("studentLogin");
    });
  }

  /* ----------------------- profile submission -------------------------- */
  let studentProfileSubmitting = false;

  function setStudentProfileLoading(isLoading) {
    studentProfileContinue.classList.toggle("is-loading", isLoading);
    studentProfileContinue.setAttribute("aria-busy", String(isLoading));
    studentProfileContinue.disabled = isLoading;
    studentProfileContinue.querySelector(".btn__label").textContent = isLoading
      ? "Saving." : "Continue";
  }

  studentProfileForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (studentProfileSubmitting) return;

    const level = sProfileGrade.value;
    const levelOther = sProfileGradeOther.value.trim();
    const checks = [
      ["student-profile-name", validateStudentFullName(sProfileName.value), sProfileName],
      ["student-profile-email", validateEmailValue(sProfileEmail.value), sProfileEmail],
      ["student-profile-grade", validateStudentLevel(level, levelOther), sProfileGrade],
      ["student-profile-grade-other", level === "other" && !levelOther ? "Tell us your class or level." : "", sProfileGradeOther],
    ];

    let firstInvalid = null;
    checks.forEach(function (item) {
      setFieldError(item[0], item[1]);
      if (item[1] && !firstInvalid) firstInvalid = item[2];
    });
    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      return;
    }

    readStudentProfileForm();
    studentProfileSubmitting = true;
    setStudentProfileLoading(true);
    persistStudentProfile(false)
      .then(function () {
        navigate("studentReview");
      })
      .catch(showStudentProfileApiError)
      .finally(function () {
        studentProfileSubmitting = false;
        setStudentProfileLoading(false);
      });
  });

  studentProfileBack.addEventListener("click", function () {
    // Once the dashboard has been opened, the profile screen is reached from
    // there, so Back returns to it instead of the signup demo.
    if (studentDashboardUnlocked) {
      navigate("studentDashboard");
      return;
    }
    navigate("student");
  });

  /* --------------------------- review actions -------------------------- */
  studentReviewEdit.addEventListener("click", function () {
    navigate("studentProfile");
  });

  let studentConfirmSubmitting = false;

  studentConfirmProfile.addEventListener("click", function () {
    if (studentConfirmSubmitting) return;
    // Mark completion only after the server confirms it.
    studentConfirmSubmitting = true;
    studentConfirmProfile.classList.add("is-loading");
    studentConfirmProfile.setAttribute("aria-busy", "true");
    studentConfirmProfile.disabled = true;
    persistStudentProfile(true)
      .then(function () {
        studentState.completed = true;
        studentReviewContent.hidden = true;
        studentReviewComplete.hidden = false;
        studentReviewComplete.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      })
      .catch(function (error) {
        showStudentProfileApiError(error);
        navigate("studentProfile");
      })
      .finally(function () {
        studentConfirmSubmitting = false;
        studentConfirmProfile.classList.remove("is-loading");
        studentConfirmProfile.removeAttribute("aria-busy");
        studentConfirmProfile.disabled = false;
      });
  });

  studentReviewAgain.addEventListener("click", function () {
    studentReviewComplete.hidden = true;
    studentReviewContent.hidden = false;
    renderStudentReview();
    if (studentReviewTitle) studentReviewTitle.focus({ preventScroll: true });
  });

  studentDashboardNext.addEventListener("click", function () {
    navigate("studentDashboard");
  });

  /* ========== Student dashboard (, Part 3) ====================== */
  // The dashboard is a pure view over `studentState.profile` — it never keeps
  // its own copy of the student's details, and every count that has no real
  // data behind it is shown as an honest zero.
  const studentDashboardView = document.getElementById("view-student-dashboard");
  const sdashMenu = document.getElementById("sdash-menu");
  const sdashScrim = document.getElementById("sdash-scrim");
  const sdashWelcomeName = document.getElementById("sdash-welcome-name");
  const sdashHeroName = document.getElementById("sdash-hero-name");
  const sdashHeroLevel = document.getElementById("sdash-hero-level");
  const sdashAvatar = document.getElementById("sdash-avatar");
  const sdashRing = document.getElementById("sdash-ring");
  const sdashPct = document.getElementById("sdash-pct");
  const sdashPctCaption = document.getElementById("sdash-pct-caption");
  const sdashPctNote = document.getElementById("sdash-pct-note");
  const sdashMeter = document.getElementById("sdash-meter");
  const sdashChecklist = document.getElementById("sdash-checklist");
  const sdashCompletionAction = document.getElementById("sdash-completion-action");
  const sstatCompletionValue = document.getElementById("sstat-completion-value");
  const sstatCompletionMeta = document.getElementById("sstat-completion-meta");
  const sqaProfile = document.getElementById("sqa-profile");
  const sqaProfileLabel = document.getElementById("sqa-profile-label");
  const sqaProfileMeta = document.getElementById("sqa-profile-meta");
  const sqaTeachers = document.getElementById("sqa-teachers");
  const sqaBookings = document.getElementById("sqa-bookings");
  const sqaReviews = document.getElementById("sqa-reviews");
  const sprofileEditBtn = document.getElementById("sprofile-edit-btn");
  const sprofileOverviewList = document.getElementById("sprofile-overview-list");
  const sprofileIncomplete = document.getElementById("sprofile-incomplete");
  const sprofileIncompleteList = document.getElementById("sprofile-incomplete-list");

  const STUDENT_DASH_TABS = {
    home: "#/student-dashboard",
    profile: "#/student-dashboard/profile",
    teachers: "#/student-dashboard/teachers",
    // Teacher details is a sub-screen of Find Teachers (, Part 5).
    teacher: "#/student-dashboard/teacher",
    // Demo lesson booking is a sub-screen of the teacher profile (, Part 1).
    book: "#/student-dashboard/book",
    // Review submission is a sub-screen of a booking (, Part 4).
    review: "#/student-dashboard/review",
    bookings: "#/student-dashboard/bookings",
    reviews: "#/student-dashboard/reviews",
    notifications: "#/student-dashboard/notifications",
    
    attendance: "#/student-dashboard/attendance",
    settings: "#/student-dashboard/settings",
  };
  const STUDENT_DASH_TAB_KEYS = ["home", "profile", "teachers", "bookings", "reviews", "attendance", "notifications", "settings"];

  let sdashNavOpen = false;
  let studentDashboardUnlocked = false; // true once the dashboard has been opened

  // The selected teacher is carried in the hash as a stable id, so a refresh or
  // a direct link reopens the same teacher rather than a display-name guess.
  function studentTeacherIdFromHash(hash) {
    const raw = String(hash || "");
    const prefix = "#/student-dashboard/teacher/";
    if (raw.toLowerCase().indexOf(prefix) === 0) {
      return raw.slice(prefix.length).replace(/\/+$/, "");
    }
    return "";
  }

  function studentDashTabFromHash(hash) {
    const h = String(hash || "").toLowerCase().replace(/\/+$/, "");
    if (h === "#/student-dashboard/teacher" || h.indexOf("#/student-dashboard/teacher/") === 0) {
      return "teacher";
    }
    if (h === "#/student-dashboard/book" || h.indexOf("#/student-dashboard/book/") === 0) {
      return "book";
    }
    if (h === "#/student-dashboard/review") return "review";
    if (h === "#/student-dashboard/profile") return "profile";
    if (h === "#/student-dashboard/teachers") return "teachers";
    if (h === "#/student-dashboard/bookings") return "bookings";
    if (h === "#/student-dashboard/reviews") return "reviews";
    if (h === "#/student-dashboard/attendance") return "attendance";
    if (h === "#/student-dashboard/notifications") return "notifications";
    if (h === "#/student-dashboard/settings") return "settings";
    return "home";
  }

  function showStudentDashTab(tab) {
    const hash = STUDENT_DASH_TABS[tab] || STUDENT_DASH_TABS.home;
    if (location.hash !== hash) {
      try {
        history.pushState({ view: "studentDashboard", tab: tab }, "", hash);
      } catch (err) {
        try {
          location.hash = hash;
        } catch (err2) {
          /* the render below still runs */
        }
      }
    }
    renderStudentDashboard(true);
  }

  /* ------------------------- completion model -------------------------- */
  // Only the three fields the setup flow actually requires count towards the
  // percentage. The photo and the introduction are optional, so they are
  // listed but can never be the reason a profile is not 100%.
  function studentCompletionItems() {
    const p = studentState.profile;
    const levelDone = !!p.level && (p.level !== "other" || !!p.levelOther);
    return [
      { label: "Full name", done: !!p.fullName, required: true },
      { label: "Contact email", done: !validateEmailValue(p.email), required: true },
      { label: "Class or education level", done: levelDone, required: true },
      { label: "Profile photo", done: !!p.photoUrl, required: false },
      { label: "Introduction", done: !!p.intro, required: false },
    ];
  }

  function studentRequiredItems() {
    return studentCompletionItems().filter(function (item) {
      return item.required;
    });
  }

  function studentCompletionPct() {
    const required = studentRequiredItems();
    if (!required.length) return 0;
    const done = required.filter(function (item) {
      return item.done;
    }).length;
    return Math.round((done / required.length) * 100);
  }

  function studentMissingRequired() {
    return studentRequiredItems().filter(function (item) {
      return !item.done;
    });
  }

  function studentDashboardName() {
    const p = studentState.profile;
    return String(p.fullName || studentState.signup.fullName || "").trim();
  }

  /* ---------------------------- rendering ------------------------------ */
  function renderStudentDashboardIdentity() {
    const name = studentDashboardName();
    const firstName = name ? name.split(/\s+/)[0] : "";
    const greeting = firstName || "Student";
    sdashWelcomeName.textContent = greeting;
    sdashHeroName.textContent = greeting;

    sdashAvatar.innerHTML = "";
    const photo = studentState.profile.photoUrl;
    if (photo) {
      const img = document.createElement("img");
      img.src = photo;
      img.alt = name ? "Profile photo of " + name : "Profile photo";
      sdashAvatar.appendChild(img);
    } else {
      const initials = initialsFrom(name);
      if (initials) {
        sdashAvatar.textContent = initials;
      } else {
        sdashAvatar.innerHTML =
          '<svg width="22" height="22" aria-hidden="true"><use href="#i-user" /></svg>';
      }
    }

    const p = studentState.profile;
    if (p.level) {
      sdashHeroLevel.textContent =
        "Class or level: " + studentLevelLabel(p.level, p.levelOther);
      sdashHeroLevel.hidden = false;
    } else {
      sdashHeroLevel.textContent = "";
      sdashHeroLevel.hidden = true;
    }
  }

  function renderStudentCompletion() {
    const items = studentCompletionItems();
    const required = items.filter(function (item) {
      return item.required;
    });
    const done = required.filter(function (item) {
      return item.done;
    }).length;
    const pct = required.length ? Math.round((done / required.length) * 100) : 0;

    sdashPct.textContent = pct + "%";
    sdashRing.style.setProperty("--pct", String(pct));
    sdashRing.setAttribute("aria-label", "Profile completion " + pct + " percent");
    sdashMeter.style.width = pct + "%";
    sdashPctCaption.textContent = pct + "% complete";
    sdashPctNote.textContent =
      pct === 100
        ? "All required details are filled in."
        : done + " of " + required.length + " required details captured.";

    const sHint = document.getElementById("sdash-completion-hint");
    if (sHint) {
      sHint.textContent =
        pct === 100
          ? "Your profile setup is 100% complete! Adding an optional photo helps teachers recognize you."
          : "Complete the remaining required fields to reach 100%. Photo and intro are optional enhancements.";
    }

    const sCountEl = document.getElementById("sdash-checklist-count");
    if (sCountEl) {
      sCountEl.textContent = done + " of " + required.length + " required";
    }

    sdashChecklist.innerHTML = "";
    items.forEach(function (item) {
      const isReq = item.required !== false;
      const li = document.createElement("li");
      if (item.done) {
        li.className = "is-done";
      } else if (!isReq) {
        li.className = "is-optional";
      }

      const mark = document.createElement("span");
      mark.className = "checklist__mark";
      mark.setAttribute("aria-hidden", "true");
      if (item.done) {
        mark.innerHTML = '<svg width="11" height="11" aria-hidden="true"><use href="#i-check" /></svg>';
      } else if (!isReq) {
        mark.innerHTML = '<span class="checklist__mark-opt" aria-hidden="true">+</span>';
      }

      const textWrap = document.createElement("span");
      textWrap.className = "checklist__text";

      const text = document.createElement("span");
      text.textContent = item.label;
      textWrap.appendChild(text);

      if (!isReq) {
        const badge = document.createElement("span");
        badge.className = "checklist__badge-optional";
        badge.textContent = "Optional";
        textWrap.appendChild(badge);
      }

      li.appendChild(mark);
      li.appendChild(textWrap);
      sdashChecklist.appendChild(li);
    });

    // Point the student at whatever is still missing.
    const missing = studentMissingRequired();
    if (missing.length) {
      sdashCompletionAction.className = "profile-status profile-status--info";
      sdashCompletionAction.innerHTML =
        '<svg width="16" height="16" aria-hidden="true"><use href="#i-info" /></svg><span></span>';
      sdashCompletionAction.querySelector("span").textContent =
        "Still needed: " +
        missing
          .map(function (item) {
            return item.label;
          })
          .join(", ") +
        ". Use Edit Profile to finish it.";
      sdashCompletionAction.hidden = false;
    } else {
      sdashCompletionAction.hidden = true;
      sdashCompletionAction.innerHTML = "";
    }
  }

  function renderStudentDashboardStats() {
    const pct = studentCompletionPct();
    sstatCompletionValue.textContent = pct + "%";
    sstatCompletionMeta.textContent =
      pct === 100
        ? "All required details are filled in."
        : "Add your remaining details to finish your profile.";

    // Saved teachers, upcoming lessons and completed lessons have no data
    // source yet, so their cards stay at a literal zero.
    sqaProfileLabel.textContent = pct === 100 ? "Edit My Profile" : "Complete My Profile";
    sqaProfileMeta.textContent =
      pct === 100 ? "Update your details any time" : "Finish the required details";
  }

  function renderStudentProfileOverview() {
    const p = studentState.profile;
    sprofileOverviewList.innerHTML = "";

    const name = studentDashboardName();
    const photo = document.createElement("div");
    photo.className = "review-photo";
    if (p.photoUrl) {
      const img = document.createElement("img");
      img.src = p.photoUrl;
      img.alt = name ? "Profile photo of " + name : "Profile photo";
      photo.appendChild(img);
    } else {
      const initials = initialsFrom(name);
      if (initials) {
        const span = document.createElement("span");
        span.className = "review-photo__initials";
        span.textContent = initials;
        photo.appendChild(span);
        photo.setAttribute("role", "img");
        photo.setAttribute("aria-label", "Default avatar showing " + initials);
      } else {
        photo.setAttribute("aria-hidden", "true");
        photo.innerHTML = '<svg width="26" height="26" aria-hidden="true"><use href="#i-user" /></svg>';
      }
    }
    sprofileOverviewList.appendChild(photo);

    addReviewRow(sprofileOverviewList, "Full name", p.fullName || "Not provided");
    addReviewRow(sprofileOverviewList, "Contact email", p.email || "Not provided");
    addReviewRow(
      sprofileOverviewList,
      "Class or education level",
      p.level ? studentLevelLabel(p.level, p.levelOther) : "Not provided"
    );
    addReviewRow(sprofileOverviewList, "Introduction", p.intro || "Not provided (optional)");
    addReviewRow(sprofileOverviewList, "Profile photo", p.photoUrl ? "Added" : "Not added (optional)");
    addReviewRow(sprofileOverviewList, "Profile completion", studentCompletionPct() + "% complete");

    const missing = studentMissingRequired();
    if (missing.length) {
      sprofileIncompleteList.innerHTML = "";
      missing.forEach(function (item) {
        const li = document.createElement("li");
        li.textContent = item.label;
        sprofileIncompleteList.appendChild(li);
      });
      sprofileIncomplete.hidden = false;
    } else {
      sprofileIncompleteList.innerHTML = "";
      sprofileIncomplete.hidden = true;
    }
  }

  function renderStudentDashboard(focus) {
    studentDashboardUnlocked = true;
    const tab = studentDashTabFromHash(location.hash);

    // Teacher details is reached from Find Teachers, so that nav item stays lit.
    const activeTab =
      tab === "teacher" || tab === "book"
        ? "teachers"
        : tab === "review"
        ? "bookings"
        : tab;

    studentDashboardView.querySelectorAll("[data-sdnav]").forEach(function (btn) {
      if (btn === sdashAvatar) return; // the avatar is an action, not a nav tab
      const nav = btn.getAttribute("data-sdnav");
      const active = STUDENT_DASH_TAB_KEYS.indexOf(nav) !== -1 && nav === activeTab;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    studentDashboardView.querySelectorAll("[data-spanel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-spanel") !== tab;
    });

    renderStudentDashboardIdentity();
    renderStudentCompletion();
    renderStudentDashboardStats();
    if (tab === "profile") renderStudentProfileOverview();
    // Find Teachers re-reads the live teacher profile every time it is shown,
    // so the directory and results are never stale.
    if (tab === "teachers") renderFindTeachers();
    // Teacher details is rebuilt from the live directory every time it opens.
    if (tab === "teacher") renderTeacherDetails();
    
    if (tab === "book") renderBookingForm();
    
    if (tab === "bookings") renderStudentBookings();
    
    if (tab === "review") renderReviewForm();
    if (tab === "reviews") renderMyReviews();
    
    if (tab === "attendance") { renderStudentAttendance(); renderAttendanceStats("satt-stats", studentAttendance()); }
    if (tab === "notifications") renderNotificationCenter("sdash");
    setStudentDashNav(false);

    if (focus !== false) {
      const activePanel = studentDashboardView.querySelector('[data-spanel="' + tab + '"]');
      const heading = activePanel ? activePanel.querySelector("h1, h2") : null;
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    }
  }

  function setStudentDashNav(open) {
    sdashNavOpen = !!open;
    studentDashboardView.classList.toggle("is-nav-open", sdashNavOpen);
    sdashMenu.setAttribute("aria-expanded", String(sdashNavOpen));
    sdashMenu.setAttribute("aria-label", sdashNavOpen ? "Close navigation menu" : "Open navigation menu");
  }

  sdashMenu.addEventListener("click", function () {
    setStudentDashNav(!sdashNavOpen);
  });
  sdashScrim.addEventListener("click", function () {
    setStudentDashNav(false);
  });

  // Sidebar links and the in-panel "Back to dashboard" buttons share data-sdnav.
  studentDashboardView.querySelectorAll("[data-sdnav]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const nav = btn.getAttribute("data-sdnav");
      setStudentDashNav(false);
      if (STUDENT_DASH_TAB_KEYS.indexOf(nav) !== -1) {
        showStudentDashTab(nav);
      } else if (nav === "login") {
        // "Log out" ends the session on the server first, then returns to the
        // student login screen - never the teacher one.
        logoutSession("studentLogin");
      }
    });
  });

  sqaProfile.addEventListener("click", function () {
    navigate("studentProfile");
  });
  sqaTeachers.addEventListener("click", function () {
    showStudentDashTab("teachers");
  });
  sqaBookings.addEventListener("click", function () {
    showStudentDashTab("bookings");
  });
  sqaReviews.addEventListener("click", function () {
    showStudentDashTab("reviews");
  });

  // The Edit and Remove controls on a student's own review cards are created
  // with the list, so they are handled by one listener on the view.
  studentDashboardView.addEventListener("click", function (event) {
    const editButton = event.target.closest ? event.target.closest("[data-review-edit]") : null;
    if (editButton) {
      openReviewEdit(editButton.getAttribute("data-review-edit"));
      return;
    }
    const removeButton = event.target.closest ? event.target.closest("[data-review-delete]") : null;
    if (removeButton) {
      removeMyReview(removeButton.getAttribute("data-review-delete"));
    }
  });
  sprofileEditBtn.addEventListener("click", function () {
    // Reuses the existing profile setup screen — no second editing system.
    navigate("studentProfile");
  });

  /* ========== Find Teachers (, Part 4) ========================== */
  // Fallback for when the API returned no teachers. The authoritative list is
  // app genuinely holds is the teacher profile built up in the teacher directory —
  // the setup forms are the source of truth. So the directory is DERIVED from
  // that live profile: never hardcoded, and empty when no teacher profile
  // exists, which is shown as an honest empty state rather than fake listings.
  const ftSearchForm = document.getElementById("ft-search-form");
  const ftQuery = document.getElementById("ft-query");
  const ftSearchBtn = document.getElementById("ft-search-btn");
  const ftClearSearch = document.getElementById("ft-clear-search");
  const ftSubject = document.getElementById("ft-subject");
  const ftGrade = document.getElementById("ft-grade");
  const ftLocation = document.getElementById("ft-location");
  const ftMode = document.getElementById("ft-mode");
  const ftDay = document.getElementById("ft-day");
  const ftClearAll = document.getElementById("ft-clear-all");
  const ftSummary = document.getElementById("ft-summary");
  const ftActive = document.getElementById("ft-active");
  const ftResults = document.getElementById("ft-results");
  const ftEmpty = document.getElementById("ft-empty");
  const ftEmptyTitle = document.getElementById("ft-empty-title");
  const ftEmptyText = document.getElementById("ft-empty-text");
  const ftEmptyAction = document.getElementById("ft-empty-action");

  let ftFiltersBuilt = false;

  function teacherQualificationList() {
    const out = [];
    qualList.querySelectorAll("[data-qual]").forEach(function (row) {
      const values = {};
      row.querySelectorAll("[data-qual-input]").forEach(function (input) {
        values[input.getAttribute("data-qual-input")] = input.value.trim();
      });
      if (!values.name && !values.institution && !values.year) return;
      out.push(values);
    });
    return out;
  }

  // Reads the existing teacher profile state. Returns null when this tab has no
  // teacher profile at all, which is what keeps the results area honest.
  function collectSessionTeacher() {
    const name = pName.value.trim();
    if (!name) return null;

    const subjects = selectedSubjects();
    const availability = selectedDayObjects()
      .map(function (day) {
        const slots = (availabilitySlots[day.id] || []).filter(function (slot) {
          return timeToMinutes(slot.start) !== null && timeToMinutes(slot.end) !== null;
        });
        return { label: day.label, slots: slots };
      })
      .filter(function (entry) {
        return entry.slots.length > 0;
      });

    const area = locArea.value.trim();
    const city = locCity.value.trim();
    const state = locationStateValue();
    const country = selectedOptionText(locCountry);

    return {
      id: "session-teacher",
      name: name,
      bio: pBio.value.trim(),
      photoUrl: photoObjectUrl || null,
      subjects: subjects.map(function (s) {
        return s.label;
      }),
      grades: checkedLabels(gradeGrid, "data-grade", GRADE_OPTIONS),
      streams: checkedLabels(streamGrid, "data-stream", STREAM_OPTIONS),
      otherLevel: otherLevel.value.trim(),
      modeKey: selectedMode(),
      mode: MODE_LABELS[selectedMode()] || "",
      radius: locRadius.value || "",
      area: area,
      city: city,
      state: state,
      country: country,
      location: [area, city, state, country].filter(Boolean).join(", "),
      availability: availability,
      availableDays: availability.map(function (entry) {
        return entry.label;
      }),
      qualifications: teacherQualificationList(),
      experienceLevel: expLevel.value ? selectedOptionText(expLevel) : "",
      experienceYears: expYears.value.trim(),
    };
  }

  function teacherDirectory() {
    
    // GET /api/v1/teachers, but this function - the one Find Teachers actually
    // reads - was still returning only the teacher created in the teacher directory,
    // so the API results were fetched and then ignored. Prefer the API records;
    // fall back to the in-tab teacher only when the API returned nothing.
    if (Array.isArray(apiTeachers) && apiTeachers.length > 0) {
      return apiTeachers;
    }
    const teacher = collectSessionTeacher();
    return teacher ? [teacher] : [];
  }

  // The class/level filter is answered by the server: the API matches the
  // education level key, while the dropdown shows a label. This holds the
  // list the API returned for the selected level, and it is used for the
  // result list only - a teacher profile is still resolved from the full
  // public directory, so a teacher outside the selected level stays openable.
  let ftLevelTeachers = null;

  async function refreshFindTeacherResults() {
    const filters = currentFtFilters();
    const params = ["per_page=24"];
    if (filters.grade) {
      params.push("level=" + encodeURIComponent(filters.grade));
    }
    try {
      const payload = await apiRequest("/teachers?" + params.join("&"));
      ftLevelTeachers = filters.grade ? (payload.data || []).map(mapTeacher) : null;
    } catch (error) {
      console.warn("Teacher directory request failed:", apiErrorMessage(error));
      ftLevelTeachers = null;
    }
    renderFindTeachers();
  }

  /* ---------------------------- filters -------------------------------- */
  function buildFindTeacherFilters() {
    if (ftFiltersBuilt) return;
    ftFiltersBuilt = true;

    // Subject and class lists come from the project's own setup data, so the
    // filter can never offer something the profile forms do not support.
    const subjectNames = COMMON_SUBJECTS.map(function (s) {
      return s.label;
    }).concat(
      customSubjects.map(function (c) {
        return c.label;
      })
    );
    fillSelect(
      ftSubject,
      [{ value: "", label: "Any subject" }].concat(
        subjectNames.map(function (label) {
          return { value: label, label: label };
        })
      ),
      null
    );
    fillSelect(
      ftGrade,
      [{ value: "", label: "Any class or level" }].concat(
        GRADE_OPTIONS.map(function (g) {
          // The label is shown, the education level key is the value: the API
          // filters on the key ("9-10"), not on the label ("Classes 9-10").
          return { value: g.id, label: g.label };
        })
      ),
      null
    );
    fillSelect(
      ftMode,
      [{ value: "", label: "Any mode" }].concat(
        Object.keys(MODE_LABELS).map(function (key) {
          return { value: key, label: MODE_LABELS[key] };
        })
      ),
      null
    );
    fillSelect(
      ftDay,
      [{ value: "", label: "Any day" }].concat(
        DAYS.map(function (day) {
          return { value: day.label, label: day.label };
        })
      ),
      null
    );
  }

  function currentFtFilters() {
    return {
      query: ftQuery.value.trim().toLowerCase(),
      subject: ftSubject.value,
      grade: ftGrade.value,
      location: ftLocation.value.trim().toLowerCase(),
      mode: ftMode.value,
      day: ftDay.value,
    };
  }

  function hasActiveFtFilters(f) {
    return !!(f.query || f.subject || f.grade || f.location || f.mode || f.day);
  }

  function teacherMatches(teacher, f) {
    if (f.subject && teacher.subjects.indexOf(f.subject) === -1) return false;
    // The filter holds the education level key, so it is compared with the
    // keys of the teacher's levels.
    if (f.grade && teacher.gradeKeys.indexOf(f.grade) === -1) return false;
    if (f.mode) {
      // A teacher who teaches "Both" genuinely offers each mode, so filtering
      // by Online or In-person must include them.
      const matchesMode =
        teacher.modeKey === f.mode || (f.mode !== "both" && teacher.modeKey === "both");
      if (!matchesMode) return false;
    }
    if (f.day && teacher.availableDays.indexOf(f.day) === -1) return false;
    if (f.location) {
      const place = [teacher.area, teacher.city, teacher.state, teacher.country]
        .join(" ")
        .toLowerCase();
      if (place.indexOf(f.location) === -1) return false;
    }
    if (f.query) {
      const haystack = [
        teacher.name,
        teacher.bio,
        teacher.subjects.join(" "),
        teacher.grades.join(" "),
        teacher.streams.join(" "),
        teacher.otherLevel,
        teacher.mode,
        teacher.location,
        teacher.experienceLevel,
        teacher.qualifications
          .map(function (q) {
            return [q.name, q.institution, q.year].join(" ");
          })
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (haystack.indexOf(f.query) === -1) return false;
    }
    return true;
  }

  /* --------------------------- result cards ---------------------------- */
  function tagRow(label, values, customTagClass) {
    if (!values || !values.length) return null;
    const row = document.createElement("div");
    row.className = "tcard__row";
    const dt = document.createElement("p");
    dt.className = "tcard__row-label";
    dt.textContent = label;
    const dd = document.createElement("div");
    dd.className = "tcard__tags";
    values.forEach(function (value) {
      const tag = document.createElement("span");
      tag.className = "tag" + (customTagClass ? " " + customTagClass : "");
      tag.textContent = value;
      dd.appendChild(tag);
    });
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  function textRow(label, value) {
    if (!value) return null;
    const row = document.createElement("div");
    row.className = "tcard__row";
    const dt = document.createElement("p");
    dt.className = "tcard__row-label";
    dt.textContent = label;
    const dd = document.createElement("p");
    dd.className = "tcard__row-value";
    dd.textContent = value;
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  function renderTeacherCard(teacher) {
    const card = document.createElement("article");
    card.className = "tcard";
    card.setAttribute("data-teacher", teacher.id);

    // Header: Top row with Avatar + Identity on left, and Price / Rate Badge on right
    const head = document.createElement("div");
    head.className = "tcard__head";

    const headLeft = document.createElement("div");
    headLeft.className = "tcard__head-left";

    const avatar = document.createElement("div");
    avatar.className = "tcard__avatar";
    if (teacher.photoUrl) {
      const img = document.createElement("img");
      img.src = teacher.photoUrl;
      img.alt = "Profile photo of " + teacher.name;
      avatar.appendChild(img);
    } else {
      const initials = initialsFrom(teacher.name);
      if (initials) {
        avatar.textContent = initials;
        avatar.setAttribute("role", "img");
        avatar.setAttribute("aria-label", "Default avatar showing " + initials);
      } else {
        avatar.setAttribute("aria-hidden", "true");
        avatar.innerHTML = '<svg width="24" height="24" aria-hidden="true"><use href="#i-user" /></svg>';
      }
    }
    headLeft.appendChild(avatar);

    const identity = document.createElement("div");
    identity.className = "tcard__identity";

    const nameRow = document.createElement("div");
    nameRow.className = "tcard__name-row";

    const name = document.createElement("h3");
    name.className = "tcard__name";
    name.textContent = teacher.name;
    nameRow.appendChild(name);

    const docVerificationEnabled = platformSettings && platformSettings.general && platformSettings.general.requireTeacherDocumentVerification !== false;
    if (docVerificationEnabled && teacher.documentsVerified) {
      const vBadge = document.createElement("span");
      vBadge.className = "tcard__verified-pill";
      vBadge.title = "Documents & Qualifications Verified";
      vBadge.innerHTML = '<svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg> Verified';
      nameRow.appendChild(vBadge);
    }
    identity.appendChild(nameRow);

    // Rating + Reviews line
    const cardStats = teacherReviewStats(teacher.id);
    const ratingLine = document.createElement("div");
    ratingLine.className = "tcard__meta-line";
    if (cardStats.count) {
      ratingLine.appendChild(starsDisplay(cardStats.average));
      const cnt = document.createElement("span");
      cnt.className = "tcard__rating-count";
      cnt.textContent = cardStats.average.toFixed(1) + " (" + cardStats.count + (cardStats.count === 1 ? " review" : " reviews") + ")";
      ratingLine.appendChild(cnt);
    } else {
      const noRev = document.createElement("span");
      noRev.className = "tcard__rating-new";
      noRev.textContent = "★ New teacher";
      ratingLine.appendChild(noRev);
    }

    // Subtitle / location / mode
    const subtitle = [teacher.mode, teacher.location].filter(Boolean).join(" · ");
    if (subtitle) {
      const metaSep = document.createElement("span");
      metaSep.className = "tcard__meta-sep";
      metaSep.textContent = "·";
      ratingLine.appendChild(metaSep);

      const loc = document.createElement("span");
      loc.className = "tcard__meta-loc";
      loc.textContent = subtitle;
      ratingLine.appendChild(loc);
    }
    identity.appendChild(ratingLine);
    headLeft.appendChild(identity);
    head.appendChild(headLeft);

    // Price Box on top right
    const priceBits = visiblePrices(teacher.id);
    const priceBox = document.createElement("div");
    priceBox.className = "tcard__price-box";
    if (priceBits.length) {
      const priceVal = document.createElement("div");
      priceVal.className = "tcard__price-val";
      priceVal.textContent = priceBits[0].text;
      const priceLbl = document.createElement("div");
      priceLbl.className = "tcard__price-lbl";
      priceLbl.textContent = priceBits[0].label || "per hour";
      priceBox.appendChild(priceVal);
      priceBox.appendChild(priceLbl);
    } else {
      const priceCustom = document.createElement("span");
      priceCustom.className = "tcard__price-custom";
      priceCustom.textContent = "Custom rates";
      priceBox.appendChild(priceCustom);
    }
    head.appendChild(priceBox);
    card.appendChild(head);

    // Bio snippet (clean, clamped)
    if (teacher.bio) {
      const bio = document.createElement("p");
      bio.className = "tcard__bio";
      bio.textContent = teacher.bio;
      card.appendChild(bio);
    }

    // Quick highlights row (compact chips)
    const highlights = document.createElement("div");
    highlights.className = "tcard__highlights";

    // Subjects (top 3 + counter)
    if (teacher.subjects && teacher.subjects.length) {
      const topSubjects = teacher.subjects.slice(0, 3);
      topSubjects.forEach(function (subj) {
        const chip = document.createElement("span");
        chip.className = "tcard__chip tcard__chip--subject";
        chip.textContent = subj;
        highlights.appendChild(chip);
      });
      if (teacher.subjects.length > 3) {
        const moreChip = document.createElement("span");
        moreChip.className = "tcard__chip tcard__chip--more";
        moreChip.textContent = "+" + (teacher.subjects.length - 3) + " more";
        moreChip.title = teacher.subjects.slice(3).join(", ");
        highlights.appendChild(moreChip);
      }
    }

    // Classes / grades (top 2)
    const classList = (teacher.grades || []).concat(teacher.streams || []);
    if (classList.length) {
      const classChip = document.createElement("span");
      classChip.className = "tcard__chip tcard__chip--grade";
      classChip.textContent = classList.slice(0, 2).join(", ") + (classList.length > 2 ? " +" + (classList.length - 2) : "");
      highlights.appendChild(classChip);
    }

    // Experience
    const expText = [teacher.experienceLevel, teacher.experienceYears ? teacher.experienceYears + " yrs" : ""].filter(Boolean).join(" · ");
    if (expText) {
      const expChip = document.createElement("span");
      expChip.className = "tcard__chip tcard__chip--exp";
      expChip.textContent = expText;
      highlights.appendChild(expChip);
    }

    card.appendChild(highlights);

    // Card Footer: Availability Indicator on Left, Action Buttons on Right
    const foot = document.createElement("div");
    foot.className = "tcard__foot";

    const availStatus = document.createElement("div");
    availStatus.className = "tcard__avail-status";
    if (teacher.availability && teacher.availability.length) {
      const dot = document.createElement("span");
      dot.className = "tcard__avail-dot";
      const text = document.createElement("span");
      text.className = "tcard__avail-text";
      if (teacher.availability.length >= 7) {
        text.textContent = "Available all 7 days";
      } else {
        const dayNames = teacher.availability.map(function (a) { return a.label ? a.label.slice(0, 3) : a.id; });
        text.textContent = "Available " + dayNames.join(", ");
      }
      availStatus.appendChild(dot);
      availStatus.appendChild(text);
    } else {
      const noAvail = document.createElement("span");
      noAvail.className = "tcard__avail-none";
      noAvail.textContent = "Schedule on request";
      availStatus.appendChild(noAvail);
    }
    foot.appendChild(availStatus);

    const actions = document.createElement("div");
    actions.className = "tcard__actions-group";

    const view = document.createElement("button");
    view.type = "button";
    view.className = "btn btn--ghost tcard__btn-view";
    view.setAttribute("aria-label", "View " + teacher.name + "'s profile");
    view.innerHTML = '<span class="btn__label">View profile</span>';
    view.addEventListener("click", function () {
      openTeacherProfile(teacher.id);
    });
    actions.appendChild(view);

    const book = document.createElement("button");
    book.type = "button";
    book.className = "btn btn--primary tcard__btn-book";
    book.setAttribute("aria-label", "Request a lesson with " + teacher.name);
    book.innerHTML = '<span class="btn__label">Request lesson</span>';
    book.addEventListener("click", function () {
      openBookingForm(teacher.id);
    });
    actions.appendChild(book);

    foot.appendChild(actions);
    card.appendChild(foot);

    return card;
  }

  /* ---------------------------- rendering ------------------------------ */
  function renderActiveFtFilters(f) {
    ftActive.innerHTML = "";
    if (!hasActiveFtFilters(f)) {
      ftActive.hidden = true;
      return;
    }
    const parts = [];
    if (f.query) parts.push("Search: \u201C" + ftQuery.value.trim() + "\u201D");
    if (f.subject) parts.push("Subject: " + f.subject);
    if (f.grade) parts.push("Class: " + f.grade);
    if (f.location) parts.push("Location: " + ftLocation.value.trim());
    if (f.mode) parts.push("Mode: " + (MODE_LABELS[f.mode] || f.mode));
    if (f.day) parts.push("Available on: " + f.day);
    parts.forEach(function (text) {
      const li = document.createElement("li");
      li.className = "ft-active__item";
      li.textContent = text;
      ftActive.appendChild(li);
    });
    ftActive.hidden = false;
  }

  function renderFindTeachers() {
    buildFindTeacherFilters();
    // With a class/level selected the list is the one the API returned for
    // that level; without it the full public directory is filtered here.
    const allTeachers = teacherDirectory();
    const directory = ftLevelTeachers !== null ? ftLevelTeachers : allTeachers;
    const filters = currentFtFilters();
    const active = hasActiveFtFilters(filters);
    const matches = directory.filter(function (teacher) {
      return teacherMatches(teacher, filters);
    });

    if (!allTeachers.length) {
      // The directory itself is empty: no teacher has a published profile.
      ftSummary.textContent = "No teacher profiles are available yet.";
    } else if (!directory.length) {
      // The directory holds teachers, but none of them teach the class that
      // was chosen. That is a different answer from "no teachers at all", so
      // it is not reported as a count of zero out of zero.
      ftSummary.textContent =
        "No teachers in the directory teach this class. There are " +
        allTeachers.length +
        (allTeachers.length === 1 ? " teacher" : " teachers") +
        " in the directory.";
    } else {
      ftSummary.textContent = matches.length +
        " of " +
        directory.length +
        (directory.length === 1 ? " teacher" : " teachers") +
        (active ? " match your search and filters." : " shown.");
    }

    ftClearSearch.hidden = !filters.query;
    ftClearAll.hidden = !active;
    renderActiveFtFilters(filters);

    ftResults.innerHTML = "";
    matches.forEach(function (teacher) {
      ftResults.appendChild(renderTeacherCard(teacher));
    });

    // The platform has no teachers at all, or the filters exclude every one
    // of them - two different messages for two different situations.
    if (!allTeachers.length) {
      ftEmpty.hidden = false;
      ftEmptyTitle.textContent = "No teacher profiles available yet";
      ftEmptyText.textContent =
        "No teacher profile is currently listed. Teachers appear here once an administrator " +
        "has approved their profile and made it public.";
      ftEmptyAction.hidden = true;
    } else if (!matches.length) {
      ftEmpty.hidden = false;
      ftEmptyTitle.textContent = "No teachers match your search";
      ftEmptyText.textContent =
        "Try a different subject, class or location, or clear the filters to see every " +
        "available teacher.";
      ftEmptyAction.hidden = false;
    } else {
      ftEmpty.hidden = true;
    }
  }

  function clearAllFtFilters() {
    ftQuery.value = "";
    ftSubject.value = "";
    ftGrade.value = "";
    ftLocation.value = "";
    ftMode.value = "";
    ftDay.value = "";
    // Clearing the filters also lifts the class/level restriction, so the
    // unfiltered directory is requested again.
    refreshFindTeacherResults();
  }

  ftSearchForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (currentFtFilters().grade) {
      refreshFindTeacherResults();
      return;
    }
    renderFindTeachers();
  });
  ftQuery.addEventListener("input", renderFindTeachers);
  ftLocation.addEventListener("input", renderFindTeachers);
  [ftSubject, ftGrade, ftMode, ftDay].forEach(function (select) {
    select.addEventListener("change", function () {
      // The class/level is resolved by the server, so it needs a fresh
      // request; the other filters are applied to the list in the browser.
      if (select === ftGrade) {
        refreshFindTeacherResults();
        return;
      }
      renderFindTeachers();
    });
  });
  ftClearSearch.addEventListener("click", function () {
    ftQuery.value = "";
    renderFindTeachers();
    ftQuery.focus({ preventScroll: true });
  });
  ftClearAll.addEventListener("click", clearAllFtFilters);
  ftEmptyAction.addEventListener("click", clearAllFtFilters);

  /* ========== Teacher profile details (, Part 5) ================ */
  // Read-only student-facing view of ONE teacher, resolved by the stable id
  // carried on the result card (never by display name). Every value shown is
  // read straight from that teacher's real profile — nothing is invented, and
  // a missing record gets an honest "unavailable" state instead of a blank page.
  const tprofileBody = document.getElementById("tprofile-body");
  const tprofileAvatar = document.getElementById("tprofile-avatar");
  const tprofileName = document.getElementById("tprofile-title");
  const tprofileMeta = document.getElementById("tprofile-meta");
  const tprofileAbout = document.getElementById("tprofile-about");
  const tprofileSubjects = document.getElementById("tprofile-subjects");
  const tprofileQuals = document.getElementById("tprofile-quals");
  const tprofileLocation = document.getElementById("tprofile-location");
  const tprofileAvailability = document.getElementById("tprofile-availability");
  const tprofileUnavailable = document.getElementById("tprofile-unavailable");
  const tprofileUnavailableTitle = document.getElementById("tprofile-unavailable-title");
  const tprofileUnavailableText = document.getElementById("tprofile-unavailable-text");
  const tprofileBook = document.getElementById("tprofile-book");
  const tprofileReview = document.getElementById("tprofile-review");

  let selectedTeacherId = "";

  function openTeacherProfile(teacherId) {
    selectedTeacherId = teacherId || "";
    const hash = selectedTeacherId
      ? "#/student-dashboard/teacher/" + selectedTeacherId
      : STUDENT_DASH_TABS.teacher;
    if (location.hash !== hash) {
      try {
        history.pushState({ view: "studentDashboard", tab: "teacher" }, "", hash);
      } catch (err) {
        try {
          location.hash = hash;
        } catch (err2) {
          /* the render below still runs */
        }
      }
    }
    renderStudentDashboard(true);
  }

  // Fills a facts block, or shows a plain "nothing provided" line instead of
  // leaving an empty gap.
  function fillTeacherFacts(container, rows, emptyText) {
    container.innerHTML = "";
    const usable = rows.filter(Boolean);
    if (!usable.length) {
      const note = document.createElement("p");
      note.className = "tp-empty";
      note.textContent = emptyText;
      container.appendChild(note);
      return;
    }
    usable.forEach(function (row) {
      container.appendChild(row);
    });
  }

  function renderTeacherAvatar(teacher) {
    tprofileAvatar.innerHTML = "";
    if (teacher.photoUrl) {
      const img = document.createElement("img");
      img.src = teacher.photoUrl;
      img.alt = "Profile photo of " + teacher.name;
      tprofileAvatar.appendChild(img);
      return;
    }
    const initials = initialsFrom(teacher.name);
    if (initials) {
      tprofileAvatar.textContent = initials;
      tprofileAvatar.setAttribute("role", "img");
      tprofileAvatar.setAttribute("aria-label", "Default avatar showing " + initials);
    } else {
      tprofileAvatar.setAttribute("aria-hidden", "true");
      tprofileAvatar.innerHTML =
        '<svg width="34" height="34" aria-hidden="true"><use href="#i-user" /></svg>';
    }
  }

  /**
   * FIX 15 — reflect the admin review policy on the teacher profile.
   *
   * The "Write a review" button used to be static: always visible and always
   * enabled, even when no policy was configured or the student had not met it.
   * Clicking it led to a blocked panel, so the profile promised something the
   * student could not do. The button now reflects the real eligibility state and
   * the profile states what the administrator's policy requires.
   */
  function reviewPolicyRequirementText(eligibility) {
    if (!eligibility) return "";
    if (eligibility.reason === "already-reviewed") {
      return "You have already reviewed this teacher.";
    }
    if (eligibility.reason === "no-policy") {
      return "Reviews are not open yet. An administrator has not set a review " +
        "eligibility policy, so eligibility cannot be determined.";
    }
    if (eligibility.determinable && !eligibility.eligible) {
      return eligibility.message || "You are not eligible to review this teacher yet.";
    }
    if (!eligibility.determinable) {
      return eligibility.message || "Review eligibility cannot be determined yet.";
    }
    return "";
  }

  function applyReviewButtonState(teacher) {
    if (!tprofileReview) return;
    const hint = document.getElementById("tprofile-review-hint");
    if (!teacher) return;

    const isStudent = !!(sessionUser && hasRoleName(sessionUser, "student"));
    if (!isStudent) {
      tprofileReview.hidden = true;
      if (hint) hint.hidden = true;
      return;
    }

    const eligibility = checkReviewEligibility(currentStudentId(), teacher.id);
    const text = reviewPolicyRequirementText(eligibility);
    const allowed = !!eligibility.eligible;

    tprofileReview.hidden = false;
    tprofileReview.disabled = !allowed;
    tprofileReview.setAttribute("aria-disabled", allowed ? "false" : "true");
    if (!allowed) {
      tprofileReview.setAttribute("title", text);
    } else {
      tprofileReview.removeAttribute("title");
    }

    if (hint) {
      hint.textContent = text;
      hint.hidden = !text;
      hint.setAttribute("role", text ? "status" : "presentation");
    }
  }

  function renderTeacherDetails() {
    const id = studentTeacherIdFromHash(location.hash) || selectedTeacherId;
    const teacher =
      teacherDirectory().filter(function (entry) {
        return String(entry.id) === String(id);
      })[0] || null;

    if (!teacher) {
      tprofileBody.hidden = true;
      tprofileUnavailable.hidden = false;
      tprofileUnavailableTitle.textContent = "Teacher profile unavailable";
      tprofileUnavailableText.textContent = id
        ? "This teacher profile is no longer available in the teacher directory. Go back to search " +
          "to see the teachers that are."
        : "No teacher profile is available to open yet. Teacher profiles appear here once a " +
          "teacher has completed their profile.";
      tprofileUnavailableTitle.setAttribute("tabindex", "-1");
      tprofileUnavailableTitle.focus({ preventScroll: true });
      return;
    }

    tprofileUnavailable.hidden = true;
    tprofileBody.hidden = false;

    renderTeacherAvatar(teacher);
    applyReviewButtonState(teacher);
    tprofileName.textContent = teacher.name;
    const docVerificationEnabled = platformSettings && platformSettings.general && platformSettings.general.requireTeacherDocumentVerification !== false;
    const verifiedBadge = document.getElementById("tprofile-verified-badge");
    if (verifiedBadge) verifiedBadge.hidden = !(docVerificationEnabled && teacher.documentsVerified);
    const meta = [teacher.mode, teacher.location].filter(Boolean).join(" \u00b7 ");
    tprofileMeta.textContent = meta;
    tprofileMeta.hidden = !meta;

    // Header rating summary & price pill
    const heroRating = document.getElementById("tprofile-hero-rating");
    if (heroRating) {
      heroRating.innerHTML = "";
      const stats = teacherReviewStats(teacher.id);
      if (stats.count) {
        heroRating.appendChild(starsDisplay(stats.average));
        const cnt = document.createElement("span");
        cnt.className = "tp-hero__rating-count";
        cnt.textContent = stats.average.toFixed(1) + " (" + stats.count + (stats.count === 1 ? " review" : " reviews") + ")";
        heroRating.appendChild(cnt);
      } else {
        const newBadge = document.createElement("span");
        newBadge.className = "tp-hero__rating-new";
        newBadge.textContent = "★ New teacher";
        heroRating.appendChild(newBadge);
      }
    }

    const heroPrice = document.getElementById("tprofile-hero-price");
    if (heroPrice) {
      heroPrice.innerHTML = "";
      const priceBits = visiblePrices(teacher.id);
      if (priceBits.length) {
        const val = document.createElement("span");
        val.className = "tp-hero__price-val";
        val.textContent = priceBits[0].text;
        const lbl = document.createElement("span");
        lbl.className = "tp-hero__price-lbl";
        lbl.textContent = " / " + (priceBits[0].label || "hr");
        heroPrice.appendChild(val);
        heroPrice.appendChild(lbl);
      } else {
        const custom = document.createElement("span");
        custom.className = "tp-hero__price-custom";
        custom.textContent = "Custom rates";
        heroPrice.appendChild(custom);
      }
    }

    // 1. About the teacher
    fillTeacherFacts(
      tprofileAbout,
      [textRow("Biography", teacher.bio)],
      "This teacher has not added a biography yet."
    );

    // 2. Subjects and classes (styled with distinct badge classes)
    fillTeacherFacts(
      tprofileSubjects,
      [
        tagRow("Subjects taught", teacher.subjects, "tag--subject"),
        tagRow("Classes and levels", (teacher.grades || []).concat(teacher.streams || []), "tag--grade"),
        textRow("Other level", teacher.otherLevel),
      ],
      "This teacher has not listed any subjects or classes yet."
    );

    // 3. Qualifications and experience
    tprofileQuals.innerHTML = "";
    const hasQuals = teacher.qualifications && teacher.qualifications.length;
    const hasExp = teacher.experienceLevel || teacher.experienceYears;
    if (hasQuals || hasExp) {
      if (hasQuals) {
        const qTitle = document.createElement("p");
        qTitle.className = "tcard__row-label";
        qTitle.textContent = "Qualifications & Education";
        tprofileQuals.appendChild(qTitle);

        const qList = document.createElement("div");
        qList.className = "tp-quals-list";
        teacher.qualifications.forEach(function (q) {
          const item = document.createElement("div");
          item.className = "tp-qual-card";
          const icon = document.createElement("span");
          icon.className = "tp-qual-icon";
          icon.innerHTML = '<svg width="18" height="18" aria-hidden="true"><use href="#i-grad" /></svg>';
          const textWrap = document.createElement("div");
          const qName = document.createElement("strong");
          qName.className = "tp-qual-name";
          qName.textContent = q.name;
          const qInst = document.createElement("span");
          qInst.className = "tp-qual-meta";
          qInst.textContent = [q.institution, q.year].filter(Boolean).join(" · ");
          textWrap.appendChild(qName);
          if (qInst.textContent) textWrap.appendChild(qInst);
          item.appendChild(icon);
          item.appendChild(textWrap);
          qList.appendChild(item);
        });
        tprofileQuals.appendChild(qList);
      }

      if (hasExp) {
        const expLevelStr = teacher.experienceLevel
          ? teacher.experienceLevel.charAt(0).toUpperCase() + teacher.experienceLevel.slice(1)
          : "";
        const expYearsStr = teacher.experienceYears
          ? teacher.experienceYears + " years of teaching experience"
          : "";
        const expCombined = [expLevelStr, expYearsStr].filter(Boolean).join(" · ");

        if (expCombined) {
          const eTitle = document.createElement("p");
          eTitle.className = "tcard__row-label";
          eTitle.style.marginTop = hasQuals ? "16px" : "0";
          eTitle.textContent = "Experience Level";
          tprofileQuals.appendChild(eTitle);

          const expCard = document.createElement("div");
          expCard.className = "tp-exp-card";
          expCard.innerHTML =
            '<span class="tp-qual-icon"><svg width="18" height="18" aria-hidden="true"><use href="#i-briefcase" /></svg></span>' +
            '<div><strong class="tp-qual-name">' + expCombined + '</strong></div>';
          tprofileQuals.appendChild(expCard);
        }
      }
    } else {
      const empty = document.createElement("p");
      empty.className = "tp-empty";
      empty.textContent = "This teacher has not added qualifications or experience yet.";
      tprofileQuals.appendChild(empty);
    }

    // 4. Prices
    tprofilePrices.innerHTML = "";
    const pBits = visiblePrices(teacher.id);
    if (pBits.length) {
      const priceGrid = document.createElement("div");
      priceGrid.className = "tp-price-grid";
      pBits.forEach(function (p) {
        const card = document.createElement("div");
        card.className = "tp-price-card";
        const val = document.createElement("div");
        val.className = "tp-price-val";
        val.textContent = p.text;
        const lbl = document.createElement("div");
        lbl.className = "tp-price-lbl";
        lbl.textContent = p.label;
        card.appendChild(val);
        card.appendChild(lbl);
        priceGrid.appendChild(card);
      });
      tprofilePrices.appendChild(priceGrid);
    } else {
      const card = document.createElement("div");
      card.className = "tp-price-card tp-price-card--custom";
      card.innerHTML = '<div class="tp-price-val">Custom Rates</div><div class="tp-price-lbl">Lesson pricing is discussed and agreed upon booking.</div>';
      tprofilePrices.appendChild(card);
    }

    // 5. Location and Teaching Mode
    tprofileLocation.innerHTML = "";
    const locBox = document.createElement("div");
    locBox.className = "tp-loc-box";

    if (teacher.location) {
      const locRow = document.createElement("div");
      locRow.className = "tp-loc-row";
      locRow.innerHTML = '<span class="tp-loc-icon"><svg width="18" height="18" aria-hidden="true"><use href="#i-pin" /></svg></span><div><p class="tp-loc-label">Location / Area</p><p class="tp-loc-val">' + teacher.location + '</p></div>';
      locBox.appendChild(locRow);
    }

    if (teacher.mode) {
      const modeRow = document.createElement("div");
      modeRow.className = "tp-loc-row";
      const radText = teacher.modeKey !== "online" && teacher.radius ? " (" + teacher.radius + ")" : "";
      modeRow.innerHTML = '<span class="tp-loc-icon"><svg width="18" height="18" aria-hidden="true"><use href="#i-wifi" /></svg></span><div><p class="tp-loc-label">Teaching Mode</p><p class="tp-loc-val">' + teacher.mode + radText + '</p></div>';
      locBox.appendChild(modeRow);
    }
    tprofileLocation.appendChild(locBox);

    // 6. Availability (rendered as schedule day capsules!)
    tprofileAvailability.innerHTML = "";
    if (teacher.availability && teacher.availability.length) {
      const grid = document.createElement("div");
      grid.className = "tp-avail-grid";
      teacher.availability.forEach(function (entry) {
        const chip = document.createElement("div");
        chip.className = "tp-avail-chip";

        const dot = document.createElement("span");
        dot.className = "tp-avail-dot";
        chip.appendChild(dot);

        const day = document.createElement("span");
        day.className = "tp-avail-day";
        day.textContent = entry.label || entry.id;
        chip.appendChild(day);

        const time = document.createElement("span");
        time.className = "tp-avail-time";
        const slotText = entry.slots
          .map(function (s) {
            return formatTime(s.start) + " – " + formatTime(s.end);
          })
          .join(", ");
        time.textContent = slotText;
        chip.appendChild(time);

        grid.appendChild(chip);
      });
      tprofileAvailability.appendChild(grid);
    } else {
      const empty = document.createElement("p");
      empty.className = "tp-empty";
      empty.textContent = "This teacher has no teaching hours published at the moment, so no lesson can be requested.";
      tprofileAvailability.appendChild(empty);
    }

    // 7. Ratings and reviews
    renderTeacherReviews(teacher);

    tprofileName.focus({ preventScroll: true });
  }

  
  tprofileBook.addEventListener("click", function () {
    openBookingForm(studentTeacherIdFromHash(location.hash) || selectedTeacherId);
  });
  tprofileReview.addEventListener("click", function () {
    // FIX 15 — if the student is not eligible, say why instead of opening a
    // panel that can only refuse them.
    const id = studentTeacherIdFromHash(location.hash) || selectedTeacherId;
    const teacher = resolveTeacher(id);
    const eligibility = teacher
      ? checkReviewEligibility(currentStudentId(), teacher.id)
      : null;
    if (eligibility && !eligibility.eligible) {
      const hint = document.getElementById("tprofile-review-hint");
      const text = reviewPolicyRequirementText(eligibility);
      if (hint) {
        hint.textContent = text;
        hint.hidden = false;
      }
      showToast(text || "You are not eligible to review this teacher yet.");
      return;
    }
    openReviewForm(id);
  });

  /* ========== Demo lesson booking (, Part 1) ==================== */
  const bookBody = document.getElementById("book-body");
  const bookForm = document.getElementById("book-form");
  const bookBack = document.getElementById("book-back");
  const bookAvatar = document.getElementById("book-avatar");
  const bookTeacherName = document.getElementById("book-teacher-name");
  const bookTeacherMeta = document.getElementById("book-teacher-meta");
  const bookPlan = document.getElementById("book-plan");
  const bookPhone = document.getElementById("book-phone");
  const bookSubject = document.getElementById("book-subject");
  const bookDate = document.getElementById("book-date");
  const bookTime = document.getElementById("book-time");
  const bookMode = document.getElementById("book-mode");
  const bookDuration = document.getElementById("book-duration");
  const bookMessage = document.getElementById("book-message");
  const bookMessageCount = document.getElementById("book-message-count");
  const bookSubmit = document.getElementById("book-submit");
  const bookCancel = document.getElementById("book-cancel");
  const bookSuccess = document.getElementById("book-success");
  const bookSuccessText = document.getElementById("book-success-text");
  const bookViewBookings = document.getElementById("book-view-bookings");
  const bookAnother = document.getElementById("book-another");
  const bookUnavailable = document.getElementById("book-unavailable");
  const bookUnavailableTitle = document.getElementById("book-unavailable-title");
  const bookUnavailableText = document.getElementById("book-unavailable-text");
  const bookTitle = document.getElementById("book-title");

  const BOOK_FIELD_ERRORS = {
    subject: "book-subject-error",
    date: "book-date-error",
    time: "book-time-error",
    mode: "book-mode-error",
    message: "book-message-error",
  };

  let bookingTeacherId = "";
  let bookingSubmitting = false;

  /* booking-slots:start */
  // The weekday keys the teacher API uses, and the order a teaching week is
  // shown in. These helpers are pure so they can be exercised on their own.
  const BOOKING_WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const BOOKING_DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  // The minutes a "HH:MM" time is, or null when it is not a time.
  function bookingSlotMinutes(value) {
    if (!value || String(value).indexOf(":") === -1) return null;
    const parts = String(value).split(":");
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    if (isNaN(hours) || isNaN(minutes)) return null;
    return hours * 60 + minutes;
  }

  function bookingSlotHHMM(total) {
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
  }

  // The start times a lesson of the given length may begin at. The whole
  // lesson has to fit inside the teacher's window, exactly as the booking API
  // requires it: a 60 minute lesson in a 09:00-12:00 window may not start at
  // 11:30, because it would finish at 12:30.
  function bookingStartTimes(daySlots, durationMinutes, stepMinutes, notBefore) {
    const out = [];
    const length = Math.max(15, Number(durationMinutes) || 60);
    const step = Math.max(15, Number(stepMinutes) || 30);
    (daySlots || []).forEach(function (slot) {
      const start = bookingSlotMinutes(slot.start);
      const end = bookingSlotMinutes(slot.end);
      if (start === null || end === null || end <= start) return;
      for (let m = start; m + length <= end; m += step) {
        const value = bookingSlotHHMM(m);
        if (notBefore && value < notBefore) continue;
        if (out.indexOf(value) === -1) out.push(value);
      }
    });
    return out.sort();
  }

  // The published availability grouped by teaching day, in the order a week
  // runs. The input is the teacher's availability from the API.
  function bookingScheduleGroups(availability) {
    const groups = {};
    (availability || []).forEach(function (slot) {
      const key = slot.day || BOOKING_WEEKDAY_KEYS[Number(slot.day_of_week)] || "";
      if (!key) return;
      if (!groups[key]) groups[key] = [];
      // The teacher API calls the bounds start_time and end_time.
      groups[key].push({
        start: slot.start_time !== undefined ? slot.start_time : slot.start,
        end: slot.end_time !== undefined ? slot.end_time : slot.end,
      });
    });
    return BOOKING_DAY_ORDER.filter(function (key) {
      return groups[key] && groups[key].length;
    }).map(function (key) {
      return { day: key, slots: groups[key] };
    });
  }

  // The next dates from startDateISO that fall on one of the teaching days.
  function bookingNextTeachingDates(dayKeys, startDateISO, count, maxDays) {
    const out = [];
    const keys = dayKeys || [];
    if (!keys.length) return out;
    const parts = String(startDateISO || "").split("-");
    if (parts.length !== 3) return out;
    const cursor = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(cursor.getTime())) return out;
    const limit = Math.max(1, Number(maxDays) || 60);
    const wanted = Math.max(1, Number(count) || 6);
    const pad = function (n) {
      return String(n).padStart(2, "0");
    };
    for (let i = 0; i < limit && out.length < wanted; i++) {
      const key = BOOKING_WEEKDAY_KEYS[cursor.getDay()];
      if (keys.indexOf(key) !== -1) {
        out.push(cursor.getFullYear() + "-" + pad(cursor.getMonth() + 1) + "-" + pad(cursor.getDate()));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }
  /* booking-slots:end */

  function setBookError(key, message) {
    const el = document.getElementById(BOOK_FIELD_ERRORS[key]);
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }
  function clearBookErrors() {
    Object.keys(BOOK_FIELD_ERRORS).forEach(function (key) {
      setBookError(key, "");
    });
  }

  // The published availability the booking form works from. It is loaded per
  // teacher from the teacher API, so the hours a student sees are the hours
  // that teacher actually published, and the hours of one teacher can never
  // be shown for another.
  let bookingAvailability = null;
  let bookingAvailabilityState = "idle";
  let bookingAvailabilityFor = "";
  let bookingDurationMinutes = 60;
  const BOOKING_TIME_STEP_MINUTES = 30;
  const BOOKING_DURATION_CHOICES = [30, 60, 90, 120];

  function bookingDateWeekdayKey(dateISO) {
    const parts = String(dateISO || "").split("-");
    if (parts.length !== 3) return "";
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(date.getTime())) return "";
    return BOOKING_WEEKDAY_KEYS[date.getDay()];
  }

  function bookingSlotsForDate(dateISO) {
    const groups = bookingScheduleGroups(bookingAvailability || []);
    const group = groups.filter(function (entry) {
      return entry.day === bookingDateWeekdayKey(dateISO);
    })[0];
    return group ? group.slots : [];
  }

  function bookingStartTimesForDate(dateISO) {
    const notBefore = dateISO && dateISO === localDateISO() ? localTimeHM() : "";
    return bookingStartTimes(
      bookingSlotsForDate(dateISO),
      bookingDurationMinutes,
      BOOKING_TIME_STEP_MINUTES,
      notBefore
    );
  }

  async function loadBookingAvailability(teacherId) {
    const wanted = String(teacherId || "");
    bookingAvailabilityFor = wanted;
    bookingAvailability = null;
    bookingAvailabilityState = wanted ? "loading" : "idle";
    renderBookingAvailability();
    renderBookingTimes();
    if (!wanted) return;

    try {
      const payload = await apiRequest("/teachers/" + encodeURIComponent(wanted));
      // A slow answer for a teacher the student has already left must not
      // replace the hours of the teacher they are looking at now.
      if (bookingAvailabilityFor !== wanted) return;
      const data = (payload && payload.data) || {};
      bookingAvailability = Array.isArray(data.availability) ? data.availability : [];
      bookingAvailabilityState = "ready";
    } catch (error) {
      if (bookingAvailabilityFor !== wanted) return;
      bookingAvailability = null;
      bookingAvailabilityState = "error";
      console.warn("Teaching hours could not be loaded:", apiErrorMessage(error));
    }
    renderBookingAvailability();
    renderBookingTimes();
    renderBookingDateChips();
  }

  function renderBookingAvailability() {
    const panel = document.getElementById("book-availability");
    const hint = document.getElementById("book-availability-hint");
    if (!panel) return;
    panel.innerHTML = "";
    if (hint) {
      hint.hidden = true;
      hint.textContent = "";
    }

    if (bookingAvailabilityState === "loading") {
      const loading = document.createElement("p");
      loading.className = "field__hint";
      loading.textContent = "Loading this teacher's teaching hours…";
      panel.appendChild(loading);
      return;
    }

    if (bookingAvailabilityState === "error") {
      const failed = document.createElement("p");
      failed.className = "field__error";
      failed.textContent = "This teacher's teaching hours could not be loaded.";
      panel.appendChild(failed);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "link link--accent";
      retry.textContent = "Try again";
      retry.addEventListener("click", function () {
        loadBookingAvailability(bookingAvailabilityFor);
      });
      panel.appendChild(retry);
      return;
    }

    const groups = bookingScheduleGroups(bookingAvailability || []);
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "field__hint";
      empty.textContent =
        "This teacher has no teaching hours published at the moment, so there is no time to request.";
      panel.appendChild(empty);
      return;
    }

    groups.forEach(function (group) {
      const card = document.createElement("section");
      card.className = "avail-day";
      const head = document.createElement("div");
      head.className = "avail-day__head";
      const title = document.createElement("p");
      title.className = "avail-day__title";
      title.textContent = (DAY_LOOKUP[group.day] || {}).label || group.day;
      head.appendChild(title);
      card.appendChild(head);
      const slots = document.createElement("div");
      slots.className = "avail-slots";
      group.slots.forEach(function (slot) {
        const row = document.createElement("p");
        row.className = "avail-slot__sep";
        row.textContent = formatTime(slot.start) + " – " + formatTime(slot.end);
        slots.appendChild(row);
      });
      card.appendChild(slots);
      panel.appendChild(card);
    });

    if (hint) {
      hint.hidden = false;
      hint.textContent =
        "Only these hours can be requested, and a lesson has to fit completely inside them.";
    }
  }

  function renderBookingTimes() {
    if (!bookTime) return;
    const previous = bookTime.value;
    bookTime.innerHTML = "";
    const addOption = function (value, label) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      bookTime.appendChild(option);
    };

    if (bookingAvailabilityState === "loading") {
      addOption("", "Loading teaching hours…");
      bookTime.disabled = true;
      return;
    }
    if (bookingAvailabilityState === "error") {
      addOption("", "Teaching hours could not be loaded");
      bookTime.disabled = true;
      return;
    }
    if (!bookingScheduleGroups(bookingAvailability || []).length) {
      addOption("", "No teaching hours at the moment");
      bookTime.disabled = true;
      return;
    }
    if (!bookDate.value) {
      addOption("", "Choose a date first");
      bookTime.disabled = true;
      return;
    }

    const times = bookingStartTimesForDate(bookDate.value);
    if (!times.length) {
      const day = (DAY_LOOKUP[bookingDateWeekdayKey(bookDate.value)] || {}).label || "that day";
      addOption("", "No start time on " + day + " fits a " + bookingDurationMinutes + " minute lesson");
      bookTime.disabled = true;
      return;
    }

    addOption("", "Select a start time");
    times.forEach(function (value) {
      addOption(value, formatTime(value));
    });
    bookTime.disabled = false;
    if (times.indexOf(previous) !== -1) bookTime.value = previous;
  }

  function renderBookingDateChips() {
    const box = document.getElementById("book-dates");
    if (!box) return;
    box.innerHTML = "";
    if (bookingAvailabilityState !== "ready") return;
    const groups = bookingScheduleGroups(bookingAvailability || []);
    if (!groups.length) return;
    const days = groups.map(function (group) {
      return group.day;
    });
    bookingNextTeachingDates(days, localDateISO(), 6, 60).forEach(function (iso) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "book-date-chip" + (bookDate.value === iso ? " is-selected" : "");
      button.textContent = prettyDate(iso);
      button.addEventListener("click", function () {
        bookDate.value = iso;
        box.querySelectorAll(".book-date-chip").forEach(function (b) {
          b.classList.remove("is-selected");
        });
        button.classList.add("is-selected");
        renderBookingTimes();
        setBookError("date", "");
        setBookError("time", "");
      });
      box.appendChild(button);
    });
  }

  // The modes a booking may use are limited to what the teacher actually offers.
  function bookingModeChoices(teacher) {
    if (!teacher) return [];
    if (teacher.modeKey === "both") {
      return [
        { value: "online", label: "Online" },
        { value: "in-person", label: "In-person" },
      ];
    }
    if (teacher.modeKey === "online") return [{ value: "online", label: "Online" }];
    if (teacher.modeKey === "in-person") return [{ value: "in-person", label: "In-person" }];
    return [];
  }

  function resolveTeacher(id) {
    // Compare as strings. Ids arriving from the URL hash are strings while the
    // API returns numbers, so a strict === never matched a deep link such as
    // #/student-dashboard/teacher/24 — the profile fell back to "unavailable"
    // and the booking form refused with "This teacher is no longer available."
    const wanted = String(id);
    return (
      teacherDirectory().filter(function (entry) {
        return String(entry.id) === wanted;
      })[0] || null
    );
  }

  function openBookingForm(teacherId) {
    bookingTeacherId = teacherId || "";
    const hash = STUDENT_DASH_TABS.book;
    if (location.hash !== hash) {
      try {
        history.pushState({ view: "studentDashboard", tab: "book" }, "", hash);
      } catch (err) {
        try {
          location.hash = hash;
        } catch (err2) {
          /* the render below still runs */
        }
      }
    }
    renderStudentDashboard(true);
  }

  function renderBookingForm() {
    const teacher = resolveTeacher(bookingTeacherId);
    clearBookErrors();
    bookSuccess.hidden = true;
    bookSuccessText.textContent = "";

    if (!teacher) {
      bookBody.hidden = true;
      bookUnavailable.hidden = false;
      bookUnavailableTitle.textContent = "Booking unavailable";
      bookUnavailableText.textContent =
        "This teacher's profile is no longer available in the teacher directory, so a request cannot " +
        "be sent. Go back to search to find an available teacher.";
      return;
    }
    bookUnavailable.hidden = true;
    bookBody.hidden = false;

    // Teacher summary — read-only, so the target can never be switched by hand.
    bookAvatar.innerHTML = "";
    if (teacher.photoUrl) {
      const img = document.createElement("img");
      img.src = teacher.photoUrl;
      img.alt = "Profile photo of " + teacher.name;
      bookAvatar.appendChild(img);
    } else {
      const initials = initialsFrom(teacher.name);
      if (initials) {
        bookAvatar.textContent = initials;
        bookAvatar.setAttribute("role", "img");
        bookAvatar.setAttribute("aria-label", "Default avatar showing " + initials);
      } else {
        bookAvatar.setAttribute("aria-hidden", "true");
        bookAvatar.innerHTML = '<svg width="22" height="22" aria-hidden="true"><use href="#i-user" /></svg>';
      }
    }
    bookTeacherName.textContent = teacher.name;
    const meta = [teacher.mode, teacher.location].filter(Boolean).join(" \u00b7 ");
    bookTeacherMeta.textContent = meta;
    bookTeacherMeta.hidden = !meta;

    // Subjects the teacher actually teaches.
    fillSelect(
      bookSubject,
      teacher.subjects.length
        ? teacher.subjects.map(function (label) {
            return { value: label, label: label };
          })
        : [{ value: "", label: "No subjects listed" }],
      null
    );
    bookSubject.disabled = !teacher.subjects.length;

    const modes = bookingModeChoices(teacher);
    fillSelect(
      bookMode,
      modes.length ? modes : [{ value: "", label: "No teaching mode set" }],
      null
    );
    bookMode.disabled = !modes.length;

    // Sensible defaults: earliest bookable date is today.
    bookDate.min = localDateISO();
    if (!bookDate.value) bookDate.value = "";
    if (bookPhone && !bookPhone.value && sessionUser && sessionUser.phone) {
      bookPhone.value = sessionUser.phone;
    }
    bookMessageCount.textContent = String(bookMessage.value.length);

    // The lesson length decides which start times fit inside the teacher's
    // hours, so it is a real choice and not a hidden constant.
    fillSelect(
      bookDuration,
      BOOKING_DURATION_CHOICES.map(function (minutes) {
        return { value: String(minutes), label: minutes + " minutes" };
      }),
      null
    );
    bookDuration.value = String(bookingDurationMinutes);

    // The hours come from the teacher that is being asked, loaded from the
    // teacher API. A different teacher means a fresh load, so the hours of one
    // teacher are never shown for another.
    if (bookingAvailabilityFor !== String(teacher.id)) {
      loadBookingAvailability(teacher.id);
    } else {
      renderBookingAvailability();
      renderBookingTimes();
      renderBookingDateChips();
    }
  }

  function readBookingForm() {
    return {
      plan: bookPlan ? bookPlan.value : "monthly",
      phone: bookPhone ? bookPhone.value.trim() : "",
      subject: bookSubject.value,
      date: bookDate.value,
      time: bookTime.value,
      mode: bookMode.value,
      message: bookMessage.value.trim(),
    };
  }

  function validateBooking(values, teacher) {
    const errors = {};
    if (!teacher) {
      errors.subject = "This teacher is no longer available.";
      return errors;
    }
    if (!teacher.subjects.length) {
      errors.subject = "This teacher has not listed any subjects yet, so a request cannot be sent.";
    } else if (!values.subject || teacher.subjects.indexOf(values.subject) === -1) {
      errors.subject = "Choose a subject this teacher actually teaches.";
    }
    if (!values.date) {
      errors.date = "Choose a preferred date.";
    } else {
      const today = localDateISO();
      if (values.date < today) errors.date = "Choose today or a future date.";
      else if (isDateUnavailable(values.date, teacher.id)) {
        errors.date = "That date is unavailable — it is a platform or teacher holiday.";
      }
    }
    if (!values.time) {
      errors.time = "Choose a preferred start time.";
    } else if (values.date && values.date === localDateISO() && values.time <= localTimeHM()) {
      errors.time = "Choose a time later than the current time.";
    }
    // The hours the student may choose are the hours the teacher published.
    // The server checks all of this again - this only keeps the form honest.
    if (bookingAvailabilityState === "loading") {
      errors.time = "This teacher's teaching hours are still loading. Please wait a moment.";
    } else if (bookingAvailabilityState === "error") {
      errors.time = "This teacher's teaching hours could not be loaded. Please try again.";
    } else if (!bookingScheduleGroups(bookingAvailability || []).length) {
      errors.time = "This teacher has not set their teaching hours yet, so there is no time to request.";
    } else if (values.date && values.time) {
      const allowed = bookingStartTimesForDate(values.date);
      if (allowed.indexOf(values.time) === -1) {
        errors.time = "Choose one of the start times this teacher is available on.";
      }
    }
    const modes = bookingModeChoices(teacher).map(function (m) {
      return m.value;
    });
    if (!modes.length) {
      errors.mode = "This teacher has not set a teaching mode yet.";
    } else if (!values.mode || modes.indexOf(values.mode) === -1) {
      errors.mode = "Choose a teaching mode this teacher offers.";
    }
    if (values.message.length > BOOKING_MESSAGE_MAX) {
      errors.message = "Keep your message under " + BOOKING_MESSAGE_MAX + " characters.";
    }
    return errors;
  }

  function submitBooking(event) {
    if (event) event.preventDefault();
    // Guard against a double click creating two requests.
    if (bookingSubmitting) return;

    const teacher = resolveTeacher(bookingTeacherId);
    const values = readBookingForm();
    clearBookErrors();
    const errors = validateBooking(values, teacher);
    if (Object.keys(errors).length) {
      Object.keys(errors).forEach(function (key) {
        setBookError(key, errors[key]);
      });
      const firstKey = Object.keys(BOOK_FIELD_ERRORS).filter(function (k) {
        return errors[k];
      })[0];
      const firstField = firstKey && document.getElementById("book-" + firstKey);
      if (firstField) firstField.focus({ preventScroll: false });
      return;
    }

    // The same student must not stack identical pending requests.
    const duplicate = bookings.some(function (b) {
      return (
        b.studentId === currentStudentId() &&
        b.teacherId === teacher.id &&
        b.date === values.date &&
        b.time === values.time &&
        b.status === "pending"
      );
    });
    if (duplicate) {
      setBookError("time", "You already have a pending request for that date and time.");
      bookTime.focus();
      return;
    }

    bookingSubmitting = true;
    const modeLabel =
      (bookingModeChoices(teacher).filter(function (m) {
        return m.value === values.mode;
      })[0] || {}).label || values.mode;

    // FIX 8 — integration. This previously pushed a record into the
    // in-memory `bookings` array and reported "Request sent" without ever
    // calling the API: the request vanished on refresh while the UI claimed it
    // had been saved. The booking is now created server-side, and success is
    // only shown once the server has confirmed it.
    apiRequest("/bookings", {
      method: "POST",
      body: {
        teacher_id: teacher.id,
        subject: values.subject,
        booking_type: values.plan || "monthly",
        phone: values.phone || null,
        date: values.date,
        time: values.time,
        mode: values.mode,
        message: values.message || null,
        duration_minutes: bookingDurationMinutes,
      },
    })
      .then(function (payload) {
        bookingSubmitting = false;
        const created = payload && payload.data ? payload.data : null;
        if (!created) {
          setBookError("subject", "The request could not be saved. Please try again.");
          return null;
        }

        const planName = values.plan === "monthly"
          ? "Monthly regular tuition"
          : values.plan === "course"
          ? "Full course package"
          : "Trial / demo session";

        if (values.plan === "monthly" || values.plan === "course") {
          bookSuccessText.textContent =
            "Your " + planName.toLowerCase() + " request for " + (created.subject || values.subject) +
            " with " + (created.teacher_name || teacher.name) + " has been received! Our academic coordinator " +
            "will call or WhatsApp you" + (values.phone ? (" at " + values.phone) : "") +
            " to confirm your customized schedule and package fee before starting classes.";
        } else {
          bookSuccessText.textContent =
            "Your demo lesson request for " + (created.subject || values.subject) + " with " +
            (created.teacher_name || teacher.name) + " on " + prettyDate(values.date) +
            " at " + values.time + " (" + modeLabel + ") is submitted and pending review.";
        }
        bookBody.hidden = true;
        bookSuccess.hidden = false;
        bookSuccess.focus({ preventScroll: true });

        // Reset the form so a later request starts clean.
        bookDate.value = "";
        bookTime.value = "";
        bookMessage.value = "";
        bookMessageCount.textContent = "0";
        renderBookingTimes();

        // Re-read the authoritative list rather than trusting a local guess.
        return loadBookings().then(function () {
          refreshBookingViews();
        });
      })
      .catch(function (error) {
        bookingSubmitting = false;
        const fieldErrors = apiFieldErrors(error);
        const firstField = Object.keys(fieldErrors)[0];
        if (firstField) {
          const known = ["subject", "date", "time", "mode", "message"];
          setBookError(known.indexOf(firstField) !== -1 ? firstField : "subject", String(fieldErrors[firstField][0]));
        } else {
          setBookError("subject", apiErrorMessage(error));
        }
      });
  }

  function backToTeacherProfile() {
    const teacher = resolveTeacher(bookingTeacherId);
    selectedTeacherId = bookingTeacherId;
    if (teacher) {
      openTeacherProfile(bookingTeacherId);
    } else {
      showStudentDashTab("teachers");
    }
  }

  bookForm.addEventListener("submit", function (event) {
    submitBooking(event);
  });
  bookMessage.addEventListener("input", function () {
    bookMessageCount.textContent = String(bookMessage.value.length);
    setBookError("message", "");
  });
  [bookSubject, bookDate, bookTime, bookMode].forEach(function (control) {
    control.addEventListener("change", function () {
      clearBookErrors();
    });
  });
  // Choosing a date offers the start times of that weekday, and a different
  // lesson length changes which of them fit.
  bookDate.addEventListener("change", function () {
    renderBookingTimes();
    renderBookingDateChips();
  });
  bookDuration.addEventListener("change", function () {
    bookingDurationMinutes = Number(bookDuration.value) || 60;
    renderBookingTimes();
  });
  bookCancel.addEventListener("click", backToTeacherProfile);
  bookBack.addEventListener("click", backToTeacherProfile);
  bookAnother.addEventListener("click", backToTeacherProfile);
  bookViewBookings.addEventListener("click", function () {
    showStudentDashTab("bookings");
  });

  /* ========== Student reviews (, Part 4) ======================== */
  // ONE centralized eligibility check. The agreed direction is that an admin
  // will eventually choose the policy, so the threshold lives here and nowhere
  // else. Only "accepted-lesson" can be evaluated today: the prototype keeps
  // no attendance, lesson-completion or course records, so the other policies
  // report themselves as unavailable rather than inventing eligibility.
  const REVIEW_POLICY = {
    type: "accepted-lesson", // future: "study-days" | "lessons" | "course"
    minAcceptedLessons: 1,
    requireBothConfirmed: true, // study-days policy: both sides confirm each day
  };

  
  // form and the teacher profile. It returns a structured result rather than a
  // bare boolean so every surface explains the same thing.
  function emptyEligibility(reason, message, missing) {
    return {
      determinable: false,
      eligible: false,
      reason: reason,
      policy: {
        configured: reviewPolicy.configured,
        type: reviewPolicy.type,
        threshold: reviewPolicy.minConfirmedDays,
      },
      qualifying: 0,
      required: 0,
      remaining: 0,
      missing: missing || [],
      message: message,
    };
  }

  // Distinct lesson DATES with mutually confirmed attendance — not raw record
  // counts. Pending, disputed, absent and under-review records never qualify.
  function attendanceQualifyingDays(studentId, teacherId) {
    const dates = {};
    attendance.forEach(function (a) {
      if (!a || a.studentId !== studentId || a.teacherId !== teacherId) return;
      if (a.confirmation !== "confirmed") return;
      if (attendanceIsUnderReview(a)) return;
      if ((a.currentResult || a.result) !== "present") return;
      if (!a.date) return;
      dates[a.date] = true;
    });
    return Object.keys(dates).length;
  }

  // The completed lessons a student has with a teacher. A review is always
  // about one of these lessons.
  function completedLessonsWithTeacher(studentId, teacherId) {
    return bookings.filter(function (b) {
      return (
        String(b.studentId) === String(studentId) &&
        String(b.teacherId) === String(teacherId) &&
        (b.rawStatus || b.status) === "completed"
      );
    });
  }

  // The completed lessons that can still be reviewed: one review per lesson.
  function reviewableLessons(studentId, teacherId) {
    return completedLessonsWithTeacher(studentId, teacherId).filter(function (b) {
      return !reviews.some(function (r) {
        return String(r.studentId) === String(studentId) && String(r.bookingId) === String(b.id);
      });
    });
  }

  function checkReviewEligibility(studentId, teacherId, bookingId) {
    if (!studentId || !teacherId) {
      return emptyEligibility("missing-identity", "Sign in as a student to review a teacher.", []);
    }
    // Uniqueness: one review per completed lesson. The same student may
    // review the same teacher again for a different completed lesson.
    const completed = completedLessonsWithTeacher(studentId, teacherId);
    const reviewable = reviewableLessons(studentId, teacherId);

    if (bookingId) {
      const alreadyReviewed = reviews.some(function (r) {
        return String(r.studentId) === String(studentId) && String(r.bookingId) === String(bookingId);
      });
      if (alreadyReviewed) {
        const res = emptyEligibility(
          "already-reviewed",
          "You have already reviewed this lesson.",
          []
        );
        res.determinable = true;
        return res;
      }
    } else if (completed.length > 0 && reviewable.length === 0) {
      const res = emptyEligibility(
        "already-reviewed",
        "You have already reviewed every completed lesson with this teacher.",
        []
      );
      res.determinable = true;
      return res;
    }

    if (!reviewPolicy.configured) {
      return emptyEligibility(
        "no-policy",
        "We cannot determine your review eligibility yet because no review policy has been " +
          "configured. Reviews stay locked until a policy is supplied rather than being granted " +
          "on a guess.",
        ["a review eligibility policy"]
      );
    }

    const policy = {
      configured: true,
      type: reviewPolicy.type,
      threshold: reviewPolicy.minConfirmedDays,
    };

    // FIX 14 - mirror the server, which applies this BEFORE the type-specific
    // rule: a completed lesson with this teacher is required whenever
    // requireCompletedBooking is set (the default). Without it the client could
    // grant eligibility the server would refuse. mapBooking remaps a server
    // "completed" to "accepted" and keeps the truth in rawStatus.
    const completedWithTeacher = completed.length;

    if (reviewPolicy.requireCompletedBooking && completedWithTeacher < 1) {
      return {
        determinable: true,
        eligible: false,
        reason: "no-completed-lesson",
        policy: policy,
        qualifying: completedWithTeacher,
        required: 1,
        remaining: 1,
        missing: ["completed lesson"],
        message: "Complete at least one lesson with this teacher first.",
      };
    }

    if (reviewPolicy.type === "study-days") {
      const qualifying = attendanceQualifyingDays(studentId, teacherId);
      const required = reviewPolicy.minConfirmedDays;
      const eligible = qualifying >= required;
      return {
        determinable: true,
        eligible: eligible,
        reason: eligible ? "eligible" : "not-enough-days",
        policy: policy,
        qualifying: qualifying,
        required: required,
        remaining: Math.max(0, required - qualifying),
        missing: eligible ? [] : ["confirmed study days"],
        message: eligible
          ? "You can now rate this teacher."
          : "Your review will unlock after " + required + " mutually confirmed study day" +
            (required === 1 ? "" : "s") + ". You have " + qualifying + " so far.",
      };
    }
    if (reviewPolicy.type === "completed-lessons") {
      // FIX 14 — this used to return "unavailable" unconditionally: a // placeholder written when the prototype held no completed-lesson records.
      // It meant the completed-lessons policy could NEVER grant eligibility, no
      // matter how many lessons were finished, while the server correctly
      // reported the student eligible. Bookings now come from the API, so the
      // criterion can actually be evaluated. The server remains the authority.
      const qualifyingLessons = completedWithTeacher;
      const requiredLessons = Math.max(1, Number(reviewPolicy.minCompletedLessons || 1));
      const eligible = qualifyingLessons >= requiredLessons;
      return {
        determinable: true,
        eligible: eligible,
        reason: eligible ? "eligible" : "not-enough-lessons",
        policy: policy,
        qualifying: qualifyingLessons,
        required: requiredLessons,
        remaining: Math.max(0, requiredLessons - qualifyingLessons),
        missing: eligible ? [] : ["completed lessons"],
        message: eligible
          ? "You can now rate this teacher."
          : "Your review will unlock after " + requiredLessons + " completed lesson" +
            (requiredLessons === 1 ? "" : "s") + " with this teacher. You have " +
            qualifyingLessons + " so far.",
      };
    }
    return emptyEligibility("unknown-policy", "This review policy cannot be evaluated yet.", []);
  }

  const rvBody = document.getElementById("rv-body");
  const rvTitle = document.getElementById("rv-title");
  const rvSub = document.getElementById("rv-sub");
  const rvForm = document.getElementById("rv-form");
  const rvBack = document.getElementById("rv-back");
  const rvAvatar = document.getElementById("rv-avatar");
  const rvTeacherName = document.getElementById("rv-teacher-name");
  const rvTeacherMeta = document.getElementById("rv-teacher-meta");
  const rvStars = document.getElementById("rv-stars");
  const rvText = document.getElementById("rv-text");
  const rvTextCount = document.getElementById("rv-text-count");
  const rvLesson = document.getElementById("rv-lesson");
  const rvSubmit = document.getElementById("rv-submit");
  const rvCancel = document.getElementById("rv-cancel");
  const rvSuccess = document.getElementById("rv-success");
  const rvSuccessText = document.getElementById("rv-success-text");
  const rvViewMine = document.getElementById("rv-view-mine");
  const rvSuccessBack = document.getElementById("rv-success-back");
  const rvBlocked = document.getElementById("rv-blocked");
  const rvBlockedTitle = document.getElementById("rv-blocked-title");
  const rvBlockedText = document.getElementById("rv-blocked-text");
  const rvBlockedAction = document.getElementById("rv-blocked-action");
  const myrevList = document.getElementById("myrev-list");
  const myrevSummary = document.getElementById("myrev-summary");
  const myrevEmpty = document.getElementById("myrev-empty");

  let reviewTeacherId = "";
  let reviewBookingId = "";
  // The review that is being edited, if the student opened one for editing.
  // An edit changes the rating and the text of that review and nothing else.
  let reviewEditingId = "";
  let reviewSubmitting = false;

  function setRvError(key, message) {
    const map = { rating: "rv-rating-error", text: "rv-text-error", lesson: "rv-lesson-error" };
    const el = document.getElementById(map[key] || "rv-text-error");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  function buildStarSelector() {
    if (rvStars.children.length) return;
    for (let i = 1; i <= 5; i += 1) {
      const label = document.createElement("label");
      label.className = "star";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "rv-rating";
      input.value = String(i);
      input.className = "star__input";
      input.setAttribute("aria-label", i === 1 ? "1 star" : i + " stars");
      const glyph = document.createElement("span");
      glyph.className = "star__glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "\u2605";
      label.appendChild(input);
      label.appendChild(glyph);
      rvStars.appendChild(label);
    }
  }

  // Accessible read-only star row used in the review lists.
  function starsDisplay(rating) {
    // Accepts an average too: the glyphs round, the label keeps the real value.
    const filled = Math.round(rating);
    const wrap = document.createElement("span");
    wrap.className = "stars-display";
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", rating + " out of 5 stars");
    for (let i = 1; i <= 5; i += 1) {
      const star = document.createElement("span");
      star.className = "star__glyph" + (i <= filled ? " is-on" : "");
      star.setAttribute("aria-hidden", "true");
      star.textContent = "\u2605";
      wrap.appendChild(star);
    }
    const num = document.createElement("span");
    num.className = "stars-display__num";
    num.textContent = rating + "/5";
    wrap.appendChild(num);
    return wrap;
  }

  function openReviewForm(teacherId, bookingId) {
    // Writing a new review is never an edit.
    reviewEditingId = "";
    reviewTeacherId = teacherId || "";
    reviewBookingId = bookingId || "";
    const hash = STUDENT_DASH_TABS.review;
    if (location.hash !== hash) {
      try {
        history.pushState({ view: "studentDashboard", tab: "review" }, "", hash);
      } catch (err) {
        try {
          location.hash = hash;
        } catch (err2) {
          /* the render below still runs */
        }
      }
    }
    renderStudentDashboard(true);
  }

  // The student opens one of their own reviews for editing. The same screen
  // is used, so the rating and the text are edited exactly as they were
  // written, and the lesson behind the review cannot be changed.
  function openReviewEdit(reviewId) {
    const review = reviews.filter(function (r) { return String(r.id) === String(reviewId); })[0];
    if (!review) return;
    reviewEditingId = String(review.id);
    reviewTeacherId = String(review.teacherId || "");
    reviewBookingId = String(review.bookingId || "");
    const hash = STUDENT_DASH_TABS.review;
    if (location.hash !== hash) {
      try {
        history.pushState({ view: "studentDashboard", tab: "review" }, "", hash);
      } catch (err) {
        try {
          location.hash = hash;
        } catch (err2) {
          /* the render below still runs */
        }
      }
    }
    renderStudentDashboard(true);
  }

  function renderReviewForm() {
    const teacher = resolveTeacher(reviewTeacherId);
    buildStarSelector();
    setRvError("rating", "");
    setRvError("text", "");
    rvSuccess.hidden = true;

    // The review that is being edited, if the student opened one.
    const editing = reviewEditingId
      ? reviews.filter(function (r) { return String(r.id) === String(reviewEditingId); })[0]
      : null;

    if (rvTitle) rvTitle.textContent = editing ? "Edit your review" : "Rate your teacher";
    if (rvSub) {
      rvSub.textContent = editing
        ? "Change your rating or your words. If an administrator has hidden the review, it stays hidden."
        : "Tell other students how the lessons went. One review per completed lesson.";
    }
    const submitLabel = rvSubmit.querySelector(".btn__label");
    if (submitLabel) submitLabel.textContent = editing ? "Save changes" : "Submit review";

    if (!teacher) {
      rvBody.hidden = true;
      rvBlocked.hidden = false;
      rvBlockedTitle.textContent = "Review unavailable";
      rvBlockedText.textContent =
        "This teacher's profile is no longer available in the teacher directory, so a review cannot " +
        "be written.";
      rvBlockedAction.hidden = false;
      return;
    }

    rvAvatar.innerHTML = "";
    if (teacher.photoUrl) {
      const img = document.createElement("img");
      img.src = teacher.photoUrl;
      img.alt = "Profile photo of " + teacher.name;
      rvAvatar.appendChild(img);
    } else {
      const initials = initialsFrom(teacher.name);
      if (initials) {
        rvAvatar.textContent = initials;
        rvAvatar.setAttribute("role", "img");
        rvAvatar.setAttribute("aria-label", "Default avatar showing " + initials);
      } else {
        rvAvatar.setAttribute("aria-hidden", "true");
        rvAvatar.innerHTML = '<svg width="22" height="22" aria-hidden="true"><use href="#i-user" /></svg>';
      }
    }
    rvTeacherName.textContent = teacher.name;
    const meta = [teacher.mode, teacher.location].filter(Boolean).join(" \u00b7 ");
    rvTeacherMeta.textContent = meta;
    rvTeacherMeta.hidden = !meta;

    if (editing) {
      // The review exists, so the eligibility gate is not asked again: the
      // lesson behind it was qualified when the review was written. The
      // lesson itself cannot be changed, so the select only names it.
      if (rvLesson) {
        rvLesson.innerHTML = "";
        const option = document.createElement("option");
        option.value = String(editing.bookingId || "");
        const lesson = bookings.filter(function (b) { return String(b.id) === String(editing.bookingId); })[0];
        option.textContent = lesson
          ? prettyDate(lesson.date) + " at " + lesson.time + (lesson.subject ? " · " + lesson.subject : "")
          : "The lesson you reviewed";
        rvLesson.appendChild(option);
        rvLesson.disabled = true;
      }
      const ratingInput = document.querySelector('input[name="rv-rating"][value="' + editing.rating + '"]');
      if (ratingInput) ratingInput.checked = true;
      rvText.value = editing.text || "";
      rvBlocked.hidden = true;
      rvBody.hidden = false;
      rvTextCount.textContent = String(rvText.value.length);
      return;
    }

    const eligibility = checkReviewEligibility(currentStudentId(), teacher.id, reviewBookingId || null);
    if (!eligibility.eligible) {
      rvBody.hidden = true;
      rvBlocked.hidden = false;
      rvBlockedTitle.textContent =
        eligibility.reason === "already-reviewed" ? "Already reviewed" : "Review not available yet";
      rvBlockedText.textContent = eligibility.message;
      rvBlockedAction.hidden = false;
      return;
    }

    // The lesson the review is about. One review per completed lesson, so the
    // list only holds completed lessons that have not been reviewed yet.
    const lessons = reviewableLessons(currentStudentId(), teacher.id);
    if (rvLesson) {
      rvLesson.innerHTML = "";
      rvLesson.disabled = false;
      lessons.forEach(function (b) {
        const option = document.createElement("option");
        option.value = String(b.id);
        option.textContent = prettyDate(b.date) + " at " + b.time + (b.subject ? " · " + b.subject : "");
        rvLesson.appendChild(option);
      });
      if (reviewBookingId) {
        const preselect = lessons.filter(function (b) {
          return String(b.id) === String(reviewBookingId);
        })[0];
        if (preselect) rvLesson.value = String(reviewBookingId);
      }
    }

    rvBlocked.hidden = true;
    rvBody.hidden = false;
    rvTextCount.textContent = String(rvText.value.length);
  }

  function submitReview(event) {
    if (event) event.preventDefault();
    if (reviewSubmitting) return;
    const teacher = resolveTeacher(reviewTeacherId);
    const checked = document.querySelector('input[name="rv-rating"]:checked');
    const rating = checked ? Number(checked.value) : 0;
    const text = rvText.value.trim();
    const lessonId = rvLesson && rvLesson.value ? rvLesson.value : reviewBookingId;
    const errors = {};

    if (!teacher) {
      renderReviewForm();
      return;
    }
    if (!lessonId) {
      errors.lesson = "Choose the lesson you are reviewing.";
    }
    if (!(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      errors.rating = errors.rating || "Choose a rating from 1 to 5 stars.";
    }
    if (text.length < REVIEW_TEXT_MIN) {
      errors.text = "Write at least " + REVIEW_TEXT_MIN + " characters so the review is useful.";
    } else if (text.length > REVIEW_TEXT_MAX) {
      errors.text = "Keep your review under " + REVIEW_TEXT_MAX + " characters.";
    }
    if (Object.keys(errors).length) {
      Object.keys(errors).forEach(function (key) {
        setRvError(key, errors[key]);
      });
      if (errors.rating) {
        const first = document.querySelector('input[name="rv-rating"]');
        if (first) first.focus();
      } else {
        rvText.focus();
      }
      return;
    }

    // The eligibility gate is re-checked at submission time, not just on render.
    // An edit does not ask again: the review was written for a lesson that
    // already qualified.
    if (!reviewEditingId) {
      const eligibility = checkReviewEligibility(currentStudentId(), teacher.id, lessonId || null);
      if (!eligibility.eligible) {
        renderReviewForm();
        return;
      }
    }

    reviewSubmitting = true;

    // An edit changes the rating and the text of the review the student
    // opened, and nothing else. The server keeps the moderation state.
    if (reviewEditingId) {
      const reviewId = reviewEditingId;
      apiRequest("/reviews/" + encodeURIComponent(reviewId), {
        method: "PATCH",
        body: {
          rating: rating,
          text: text,
        },
      })
        .then(function () {
          reviewSubmitting = false;
          reviewEditingId = "";
          rvText.value = "";
          rvTextCount.textContent = "0";
          const chosen = document.querySelector('input[name="rv-rating"]:checked');
          if (chosen) chosen.checked = false;
          return loadReviews().then(function () {
            renderMyReviews();
            showStudentDashTab("reviews");
            showToast("Your review was updated.");
          });
        })
        .catch(function (error) {
          reviewSubmitting = false;
          const fieldErrors = apiFieldErrors(error);
          const firstField = Object.keys(fieldErrors)[0];
          if (firstField) {
            const known = ["rating", "text"];
            setRvError(known.indexOf(firstField) !== -1 ? firstField : "text", String(fieldErrors[firstField][0]));
          } else {
            setRvError("text", apiErrorMessage(error));
          }
        });
      return;
    }

    // FIX 9 — integration. This previously pushed into the in-memory
    // `reviews` array and showed a success panel without calling the API, so the
    // review was never stored. The server is now the authority on eligibility,
    // duplicates and validation, and its errors are surfaced verbatim.
    apiRequest("/reviews", {
      method: "POST",
      body: {
        teacher_id: Number(teacher.id),
        booking_id: Number(lessonId),
        rating: rating,
        text: text,
      },
    })
      .then(function () {
        reviewSubmitting = false;
        return loadReviews().then(function () {
          rvSuccessText.textContent = "You rated " + teacher.name + " " + rating + " out of 5.";
          rvBody.hidden = true;
          rvSuccess.hidden = false;
          rvSuccess.focus({ preventScroll: true });
          rvText.value = "";
          rvTextCount.textContent = "0";
          const chosen = document.querySelector('input[name="rv-rating"]:checked');
          if (chosen) chosen.checked = false;
          refreshBookingViews();
        });
      })
      .catch(function (error) {
        reviewSubmitting = false;
        const fieldErrors = apiFieldErrors(error);
        const firstField = Object.keys(fieldErrors)[0];
        if (firstField) {
          const known = ["rating", "text"];
          setRvError(known.indexOf(firstField) !== -1 ? firstField : "text", String(fieldErrors[firstField][0]));
        } else {
          setRvError("text", apiErrorMessage(error));
        }
      });
  }

  function reviewCard(r) {
    const card = document.createElement("article");
    card.className = "bkcard";
    card.setAttribute("data-review", r.id);
    const head = document.createElement("div");
    head.className = "bkcard__head";
    const avatar = document.createElement("div");
    avatar.className = "bkcard__avatar";
    const initials = initialsFrom(r.teacherName);
    if (initials) {
      avatar.textContent = initials;
      avatar.setAttribute("role", "img");
      avatar.setAttribute("aria-label", "Default avatar showing " + initials);
    } else {
      avatar.setAttribute("aria-hidden", "true");
      avatar.innerHTML = '<svg width="20" height="20" aria-hidden="true"><use href="#i-user" /></svg>';
    }
    const identity = document.createElement("div");
    identity.className = "bkcard__identity";
    const who = document.createElement("h3");
    who.className = "bkcard__teacher";
    who.textContent = r.teacherName || "Teacher";
    identity.appendChild(who);
    const meta = document.createElement("p");
    meta.className = "bkcard__meta";
    meta.textContent = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
    identity.appendChild(meta);
    head.appendChild(avatar);
    head.appendChild(identity);
    head.appendChild(starsDisplay(r.rating));
    card.appendChild(head);

    const body = document.createElement("p");
    body.className = "bkcard__note";
    body.textContent = r.text;
    card.appendChild(body);

    // The moderation state belongs to the administrator, but the student is
    // told about it: a review that is not published is not on the teacher's
    // profile any more.
    if (r.status && r.status !== "published") {
      const state = document.createElement("p");
      state.className = "bkcard__meta";
      state.textContent = r.status === "hidden"
        ? "Hidden by an administrator, so it is not shown on the teacher's profile."
        : "Flagged for a moderator, so it is not shown on the teacher's profile.";
      card.appendChild(state);
      if (r.moderationNote) {
        const note = document.createElement("p");
        note.className = "bkcard__meta";
        note.textContent = "Reason: " + r.moderationNote;
        card.appendChild(note);
      }
    }

    // Edit and remove. Both act on this student's own review only, and the
    // server checks that again.
    const actions = document.createElement("div");
    actions.className = "bkcard__actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn btn--ghost";
    edit.setAttribute("data-review-edit", r.id);
    edit.setAttribute("aria-label", "Edit your review of " + (r.teacherName || "this teacher"));
    edit.innerHTML = '<span class="btn__label">Edit</span>';
    actions.appendChild(edit);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--ghost";
    remove.setAttribute("data-review-delete", r.id);
    remove.setAttribute("aria-label", "Remove your review of " + (r.teacherName || "this teacher"));
    remove.innerHTML = '<span class="btn__label">Remove</span>';
    actions.appendChild(remove);
    card.appendChild(actions);

    return card;
  }

  // Average rating from real reviews only: integers 1-5, no double counting,
  // malformed records skipped, and a clean zero when there are none.
  function teacherReviewStats(teacherId) {
    const seen = {};
    let sum = 0;
    let count = 0;
    reviews.forEach(function (r) {
      if (!r || r.teacherId !== teacherId) return;
      // Only a published review counts towards the rating, exactly as the
      // server counts it. A review an administrator hid is not shown on the
      // profile, so it must not be in the average either - the number the
      // student sees has to be the number the public profile reports.
      if (r.id && seen[r.id]) return;
      if (r.status && r.status !== "published") return;
      if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) return;
      if (r.id) seen[r.id] = true;
      sum += r.rating;
      count += 1;
    });
    return {
      count: count,
      average: count ? Math.round((sum / count) * 10) / 10 : 0,
    };
  }

  // Public-facing reviewer label: first name plus a last initial, so a review
  // never publishes a student's full identity.
  function reviewerLabel(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "Student";
    if (parts.length === 1) return parts[0];
    return parts[0] + " " + parts[parts.length - 1].charAt(0).toUpperCase() + ".";
  }

  const tprofilePrices = document.getElementById("tprofile-prices");
  const tprofileRatingSummary = document.getElementById("tprofile-rating-summary");
  const tprofileReviews = document.getElementById("tprofile-reviews");

  function renderTeacherReviews(teacher) {
    const stats = teacherReviewStats(teacher.id);
    tprofileRatingSummary.innerHTML = "";
    tprofileReviews.innerHTML = "";

    if (!stats.count) {
      const empty = document.createElement("p");
      empty.className = "tp-empty";
      empty.textContent = "No reviews yet.";
      tprofileRatingSummary.appendChild(empty);
      return;
    }

    const box = document.createElement("div");
    box.className = "rating-summary";
    const avg = document.createElement("p");
    avg.className = "rating-summary__avg";
    avg.textContent = stats.average.toFixed(1);
    const side = document.createElement("div");
    side.className = "rating-summary__side";
    side.appendChild(starsDisplay(stats.average));
    const cnt = document.createElement("p");
    cnt.className = "rating-summary__count";
    cnt.textContent = stats.count === 1 ? "Based on 1 review" : "Based on " + stats.count + " reviews";
    side.appendChild(cnt);
    box.appendChild(avg);
    box.appendChild(side);
    tprofileRatingSummary.appendChild(box);

    reviews
      .filter(function (r) {
        return r.teacherId === teacher.id && Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5;
      })
      .sort(function (a, b) {
        return String(b.createdAt).localeCompare(String(a.createdAt));
      })
      .forEach(function (r) {
        const item = document.createElement("div");
        item.className = "review-item";
        const head = document.createElement("div");
        head.className = "review-item__head";
        const who = document.createElement("p");
        who.className = "review-item__title";
        who.textContent = reviewerLabel(r.studentName);
        head.appendChild(who);
        head.appendChild(starsDisplay(r.rating));
        item.appendChild(head);
        const text = document.createElement("p");
        text.className = "review-item__meta";
        text.textContent = r.text;
        item.appendChild(text);
        const when = document.createElement("p");
        when.className = "review-item__date";
        when.textContent = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
        item.appendChild(when);
        tprofileReviews.appendChild(item);
      });
  }

  // The teacher reviews panel is a read-only view of what the server holds
  // for this teacher. Nothing on it is produced locally.
  function renderTeacherReviewsPanel() {
    const list = document.getElementById("reviews-list");
    if (!list) return;
    const empty = document.getElementById("reviews-empty");
    const avgEl = document.getElementById("reviews-average");
    const starsEl = document.getElementById("reviews-average-stars");
    const avgHint = document.getElementById("reviews-average-hint");
    const totalEl = document.getElementById("reviews-total-value");
    const totalHint = document.getElementById("reviews-total-hint");

    const teacherId = currentTeacherId();
    const mine = reviews
      .filter(function (r) {
        return r.teacherId === teacherId && r.status === "published";
      })
      .sort(function (a, b) {
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
    const stats = teacherReviewStats(teacherId);

    if (avgEl) avgEl.textContent = stats.count ? stats.average.toFixed(1) : "Not rated yet";
    if (starsEl) {
      starsEl.innerHTML = "";
      if (stats.count) {
        starsEl.setAttribute("aria-label", stats.average + " out of 5 stars");
        starsEl.appendChild(starsDisplay(stats.average));
      } else {
        starsEl.setAttribute("aria-label", "No ratings yet");
        for (let i = 0; i < 5; i += 1) {
          const star = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          star.setAttribute("width", "22");
          star.setAttribute("height", "22");
          star.setAttribute("aria-hidden", "true");
          const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
          use.setAttribute("href", "#i-star");
          star.appendChild(use);
          starsEl.appendChild(star);
        }
      }
    }
    if (avgHint) {
      avgHint.textContent = stats.count
        ? "Based on " + stats.count + (stats.count === 1 ? " review" : " reviews")
        : "No star ratings have been submitted.";
    }
    if (totalEl) totalEl.textContent = String(stats.count);
    if (totalHint) {
      totalHint.textContent = stats.count
        ? (stats.count === 1 ? "1 published review." : stats.count + " published reviews.")
        : "No reviews have been received.";
    }

    list.innerHTML = "";
    mine.forEach(function (r) {
      const item = document.createElement("li");
      item.className = "review-item";
      const head = document.createElement("div");
      head.className = "review-item__head";
      const who = document.createElement("p");
      who.className = "review-item__title";
      who.textContent = reviewerLabel(r.studentName);
      head.appendChild(who);
      head.appendChild(starsDisplay(r.rating));
      item.appendChild(head);
      const text = document.createElement("p");
      text.className = "review-item__meta";
      text.textContent = r.text;
      item.appendChild(text);
      const when = document.createElement("p");
      when.className = "review-item__date";
      when.textContent = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
      item.appendChild(when);
      list.appendChild(item);
    });
    if (empty) empty.hidden = mine.length > 0;
  }

  function renderMyReviews() {
    const mine = reviews
      .filter(function (r) {
        return r.studentId === currentStudentId();
      })
      .sort(function (a, b) {
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
    myrevSummary.textContent = mine.length
      ? mine.length + (mine.length === 1 ? " review written." : " reviews written.")
      : "You have not written any reviews yet.";
    myrevList.innerHTML = "";
    mine.forEach(function (r) {
      myrevList.appendChild(reviewCard(r));
    });
    myrevEmpty.hidden = mine.length > 0;
  }

  // The student removes one of their own reviews. The dialog says what
  // happens: the review disappears from the teacher's profile, and the
  // lesson and its records stay exactly as they are.
  function removeMyReview(reviewId) {
    const review = reviews.filter(function (r) { return String(r.id) === String(reviewId); })[0];
    if (!review) return;
    const teacherName = review.teacherName || "this teacher";
    const agreed = window.confirm(
      "Remove your review of " + teacherName + "?\n\n" +
      "It is taken off the teacher's profile. The lesson, the attendance and the records " +
      "around them stay exactly as they are, and you may write a new review for that lesson."
    );
    if (!agreed) return;

    apiRequest("/reviews/" + encodeURIComponent(reviewId), { method: "DELETE" })
      .then(function (payload) {
        return loadReviews().then(function () {
          renderMyReviews();
          showToast((payload && payload.message) || "The review was removed.");
        });
      })
      .catch(function (error) {
        showToast(apiErrorMessage(error));
      });
  }

  rvForm.addEventListener("submit", function (event) {
    submitReview(event);
  });
  rvText.addEventListener("input", function () {
    rvTextCount.textContent = String(rvText.value.length);
    setRvError("text", "");
  });
  rvStars.addEventListener("change", function () {
    setRvError("rating", "");
  });
  rvBack.addEventListener("click", function () {
    reviewEditingId = "";
    showStudentDashTab("bookings");
  });
  rvCancel.addEventListener("click", function () {
    reviewEditingId = "";
    showStudentDashTab("bookings");
  });
  rvBlockedAction.addEventListener("click", function () {
    showStudentDashTab("bookings");
  });
  rvViewMine.addEventListener("click", function () {
    showStudentDashTab("reviews");
  });
  rvSuccessBack.addEventListener("click", function () {
    showStudentDashTab("bookings");
  });

  /* ========== Student bookings dashboard (, Part 2) ============= */
  const bkCountTotal = document.getElementById("bk-count-total");
  const bkCountPending = document.getElementById("bk-count-pending");
  const bkCountAccepted = document.getElementById("bk-count-accepted");
  const bkCountRejected = document.getElementById("bk-count-rejected");
  const bkCountCancelled = document.getElementById("bk-count-cancelled");
  const bkFilters = document.getElementById("bk-filters");
  const bkSummary = document.getElementById("bk-summary");
  const bkList = document.getElementById("bk-list");
  const bkEmpty = document.getElementById("bk-empty");
  const bkEmptyTitle = document.getElementById("bk-empty-title");
  const bkEmptyText = document.getElementById("bk-empty-text");
  const bkEmptyAction = document.getElementById("bk-empty-action");

  let bkFilter = "all";
  let bkConfirmingId = "";

  function bookingStatusLabel(status) {
    return BOOKING_STATUS_LABELS[status] || status || "Unknown";
  }
  // A completed lesson keeps "accepted" in the flow logic, so the label is
  // taken from the raw server status. The screen must never say that a
  // finished lesson is still waiting.
  function bookingDisplayStatus(booking) {
    return bookingStatusLabel(booking.rawStatus || booking.status);
  }
  // True once the scheduled start of the lesson has passed. The server checks
  // the same rule, so this only decides whether the action is offered.
  function bookingHasPassed(booking) {
    if (!booking || !booking.date) return false;
    const start = String(booking.date).slice(0, 10) + "T" + (String(booking.time || "00:00").slice(0, 5) || "00:00");
    const when = new Date(start);
    if (isNaN(when.getTime())) return false;
    return when.getTime() <= Date.now();
  }

  // Only this student's requests. Ownership is checked by id, not by name.
  function studentBookings() {
    const sid = currentStudentId();
    return bookings.filter(function (b) {
      return b.studentId === sid;
    });
  }

  function bookingCounts(list) {
    const counts = { all: list.length, pending: 0, accepted: 0, rejected: 0, cancelled: 0 };
    list.forEach(function (b) {
      if (Object.prototype.hasOwnProperty.call(counts, b.status)) counts[b.status] += 1;
    });
    return counts;
  }

  function bookingFact(label, value) {
    if (!value) return null;
    const row = document.createElement("div");
    row.className = "bkcard__fact";
    const dt = document.createElement("p");
    dt.className = "bkcard__fact-label";
    dt.textContent = label;
    const dd = document.createElement("p");
    dd.className = "bkcard__fact-value";
    dd.textContent = value;
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  function renderBookingCard(b) {
    const card = document.createElement("article");
    card.className = "bkcard";
    card.setAttribute("data-booking", b.id);

    // Head: teacher identity + status pill.
    const head = document.createElement("div");
    head.className = "bkcard__head";

    const avatar = document.createElement("div");
    avatar.className = "bkcard__avatar";
    const teacher = resolveTeacher(b.teacherId);
    if (teacher && teacher.photoUrl) {
      const img = document.createElement("img");
      img.src = teacher.photoUrl;
      img.alt = "Profile photo of " + b.teacherName;
      avatar.appendChild(img);
    } else {
      const initials = initialsFrom(b.teacherName);
      if (initials) {
        avatar.textContent = initials;
        avatar.setAttribute("role", "img");
        avatar.setAttribute("aria-label", "Default avatar showing " + initials);
      } else {
        avatar.setAttribute("aria-hidden", "true");
        avatar.innerHTML = '<svg width="20" height="20" aria-hidden="true"><use href="#i-user" /></svg>';
      }
    }

    const identity = document.createElement("div");
    identity.className = "bkcard__identity";
    const who = document.createElement("h3");
    who.className = "bkcard__teacher";
    who.textContent = b.teacherName || "Teacher";
    identity.appendChild(who);
    const what = document.createElement("p");
    what.className = "bkcard__meta";
    what.textContent = [b.subject, b.modeLabel].filter(Boolean).join(" \u00b7 ");
    identity.appendChild(what);

    const pill = document.createElement("span");
    pill.className = "status status--" + (b.rawStatus || b.status);
    pill.textContent = bookingDisplayStatus(b);

    head.appendChild(avatar);
    head.appendChild(identity);
    head.appendChild(pill);
    card.appendChild(head);

    // Facts.
    const facts = document.createElement("div");
    facts.className = "bkcard__facts";
    const planLabel = b.bookingType === "monthly" ? "Monthly Regular Tuition" :
                      b.bookingType === "course" ? "Full Course Package" : "Trial / Demo Lesson";
    const feeText = b.agreedPrice ? ("₹" + Number(b.agreedPrice).toLocaleString("en-IN") + " (" + (b.pricingType || b.bookingType) + ")") : null;
    [
      bookingFact("Tuition plan", planLabel),
      feeText ? bookingFact("Agreed fee", feeText) : null,
      bookingFact("Preferred date", prettyDate(b.date)),
      bookingFact("Preferred time", b.time),
      bookingFact("Teaching mode", b.modeLabel),
      bookingFact("Your message", b.message),
      bookingFact("Requested on", b.createdAt ? new Date(b.createdAt).toLocaleString() : ""),
      bookingFact("Reference", b.reference || b.id),
    ]
      .filter(Boolean)
      .forEach(function (row) {
        facts.appendChild(row);
      });
    card.appendChild(facts);

    // Actions.
    const actions = document.createElement("div");
    actions.className = "bkcard__actions";

    if (b.status === "pending") {
      if (bkConfirmingId === b.id) {
        const confirm = document.createElement("div");
        confirm.className = "bkconfirm";
        const q = document.createElement("p");
        q.className = "bkconfirm__text";
        q.textContent = "Cancel this request? This cannot be undone.";
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "btn btn--ghost";
        yes.setAttribute("data-bkcancel-yes", b.id);
        yes.innerHTML = '<span class="btn__label">Yes, cancel request</span>';
        const no = document.createElement("button");
        no.type = "button";
        no.className = "btn btn--ghost";
        no.setAttribute("data-bkcancel-no", b.id);
        no.innerHTML = '<span class="btn__label">Keep request</span>';
        confirm.appendChild(q);
        confirm.appendChild(yes);
        confirm.appendChild(no);
        actions.appendChild(confirm);
      } else {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn btn--ghost";
        cancel.setAttribute("data-bkcancel", b.id);
        cancel.innerHTML = '<span class="btn__label">Cancel request</span>';
        actions.appendChild(cancel);
      }
    } else {
      const note = document.createElement("p");
      note.className = "bkcard__note";
      note.textContent =
        b.rawStatus === "completed"
          ? "This lesson is complete. You can rate the teacher from here."
          : b.status === "cancelled"
          ? "You cancelled this request. It can no longer be cancelled again."
          : b.status === "accepted"
          ? "The teacher accepted this request. Ask them directly if you need to change it."
          : "The teacher declined this request.";
      actions.appendChild(note);
    }

    // A review is about one completed lesson, so the action is only offered
    // for a lesson that has actually been completed.
    if ((b.rawStatus || b.status) === "completed") {
      const reviewBtn = document.createElement("button");
      reviewBtn.type = "button";
      reviewBtn.className = "btn btn--ghost";
      reviewBtn.setAttribute("data-bkreview", b.id);
      reviewBtn.innerHTML = '<span class="btn__label">Rate this teacher</span>';
      actions.appendChild(reviewBtn);
    }

    card.appendChild(actions);
    return card;
  }

  function renderStudentBookings() {
    const mine = studentBookings();
    const counts = bookingCounts(mine);

    bkCountTotal.textContent = String(counts.all);
    bkCountPending.textContent = String(counts.pending);
    bkCountAccepted.textContent = String(counts.accepted);
    bkCountRejected.textContent = String(counts.rejected);
    bkCountCancelled.textContent = String(counts.cancelled);

    // Filter buttons reflect real counts and the active selection.
    bkFilters.querySelectorAll("[data-bkfilter]").forEach(function (btn) {
      const key = btn.getAttribute("data-bkfilter");
      const active = key === bkFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
      const label = key === "all" ? "All" : bookingStatusLabel(key);
      btn.textContent = label + " (" + (counts[key] || 0) + ")";
    });

    const visible = (bkFilter === "all"
      ? mine.slice()
      : mine.filter(function (b) {
          return b.status === bkFilter;
        })
    ).sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    bkSummary.textContent = mine.length
      ? bkFilter === "all"
        ? mine.length + (mine.length === 1 ? " request in total." : " requests in total.")
        : visible.length +
          " of " +
          mine.length +
          " request" +
          (mine.length === 1 ? "" : "s") +
          " are " +
          bookingStatusLabel(bkFilter).toLowerCase() +
          "."
      : "You have not sent any lesson requests yet.";

    bkList.innerHTML = "";
    visible.forEach(function (b) {
      bkList.appendChild(renderBookingCard(b));
    });

    if (!mine.length) {
      bkEmpty.hidden = false;
      bkEmptyTitle.textContent = "No lesson requests yet";
      bkEmptyText.textContent =
        "Find a teacher, open their profile and send a demo lesson request. Your requests will " +
        "appear here with their current status.";
      bkEmptyAction.hidden = true;
    } else if (!visible.length) {
      bkEmpty.hidden = false;
      bkEmptyTitle.textContent = "No " + bookingStatusLabel(bkFilter).toLowerCase() + " requests";
      bkEmptyText.textContent = "You have no requests with this status right now.";
      bkEmptyAction.hidden = false;
    } else {
      bkEmpty.hidden = true;
    }
  }

  // Cancellation updates the ORIGINAL record — no second record is created.
  function cancelBooking(id, reason) {
    // FIX 9 — cancellation is now sent to the server.
    apiRequest("/bookings/" + encodeURIComponent(id) + "/cancel", {
      method: "PATCH",
      body: { reason: reason || "Cancelled by the student." },
    })
      .then(function () { return loadBookings(); })
      .then(function () {
        refreshBookingViews();
        showToast("Booking cancelled.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  bkFilters.addEventListener("click", function (event) {
    const btn = event.target.closest("[data-bkfilter]");
    if (!btn) return;
    bkFilter = btn.getAttribute("data-bkfilter");
    bkConfirmingId = "";
    renderStudentBookings();
  });

  bkList.addEventListener("click", function (event) {
    const cancel = event.target.closest("[data-bkcancel]");
    if (cancel) {
      bkConfirmingId = cancel.getAttribute("data-bkcancel");
      renderStudentBookings();
      return;
    }
    const no = event.target.closest("[data-bkcancel-no]");
    if (no) {
      bkConfirmingId = "";
      renderStudentBookings();
      return;
    }
    const yes = event.target.closest("[data-bkcancel-yes]");
    if (yes) {
      cancelBooking(yes.getAttribute("data-bkcancel-yes"));
      return;
    }
    const review = event.target.closest("[data-bkreview]");
    if (review) {
      const record = bookings.filter(function (b) {
        return b.id === review.getAttribute("data-bkreview");
      })[0];
      if (record) openReviewForm(record.teacherId, record.id);
    }
  });

  bkEmptyAction.addEventListener("click", function () {
    bkFilter = "all";
    renderStudentBookings();
  });

  /* ========== Teacher lesson requests (, Part 3) ================ */
  const tqCountTotal = document.getElementById("tq-count-total");
  const tqCountPending = document.getElementById("tq-count-pending");
  const tqCountAccepted = document.getElementById("tq-count-accepted");
  const tqCountRejected = document.getElementById("tq-count-rejected");
  const tqCountCancelled = document.getElementById("tq-count-cancelled");
  const tqFilters = document.getElementById("tq-filters");
  const tqSummary = document.getElementById("tq-summary");
  const tqList = document.getElementById("tq-list");
  const tqEmpty = document.getElementById("tq-empty");
  const tqEmptyTitle = document.getElementById("tq-empty-title");
  const tqEmptyText = document.getElementById("tq-empty-text");
  const tqEmptyAction = document.getElementById("tq-empty-action");
  const dashRequestsBadge = document.getElementById("dash-requests-badge");

  let tqFilter = "all";
  let tqConfirmingId = "";

  // Only the current teacher's requests — matched by teacher id, not by name.
  function teacherRequests() {
    const tId = currentTeacherId();
    if (!tId) return [];
    return bookings.filter(function (b) {
      return b.teacherId === tId;
    });
  }

  function updateRequestsBadge() {
    if (!dashRequestsBadge) return;
    const pending = teacherRequests().filter(function (b) {
      return b.status === "pending";
    }).length;
    dashRequestsBadge.textContent = String(pending);
    dashRequestsBadge.hidden = pending === 0;
  }

  function requestFact(label, value) {
    if (!value) return null;
    const row = document.createElement("div");
    row.className = "bkcard__fact";
    const dt = document.createElement("p");
    dt.className = "bkcard__fact-label";
    dt.textContent = label;
    const dd = document.createElement("p");
    dd.className = "bkcard__fact-value";
    dd.textContent = value;
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  function renderRequestCard(b) {
    const card = document.createElement("article");
    card.className = "bkcard";
    card.setAttribute("data-request", b.id);

    const head = document.createElement("div");
    head.className = "bkcard__head";
    const avatar = document.createElement("div");
    avatar.className = "bkcard__avatar";
    const initials = initialsFrom(b.studentName);
    if (initials) {
      avatar.textContent = initials;
      avatar.setAttribute("role", "img");
      avatar.setAttribute("aria-label", "Default avatar showing " + initials);
    } else {
      avatar.setAttribute("aria-hidden", "true");
      avatar.innerHTML = '<svg width="20" height="20" aria-hidden="true"><use href="#i-user" /></svg>';
    }
    const identity = document.createElement("div");
    identity.className = "bkcard__identity";
    const who = document.createElement("h3");
    who.className = "bkcard__teacher";
    // Never invent a name — say plainly when the student did not give one.
    who.textContent = b.studentName || "Student (no name provided)";
    identity.appendChild(who);
    const what = document.createElement("p");
    what.className = "bkcard__meta";
    what.textContent = [b.subject, b.modeLabel].filter(Boolean).join(" \u00b7 ");
    identity.appendChild(what);
    const pill = document.createElement("span");
    pill.className = "status status--" + (b.rawStatus || b.status);
    pill.textContent = bookingDisplayStatus(b);
    head.appendChild(avatar);
    head.appendChild(identity);
    head.appendChild(pill);
    card.appendChild(head);

    const facts = document.createElement("div");
    facts.className = "bkcard__facts";
    [
      requestFact("Preferred date", prettyDate(b.date)),
      requestFact("Preferred time", b.time),
      requestFact("Teaching mode", b.modeLabel),
      requestFact("Student message", b.message),
      requestFact("Requested on", b.createdAt ? new Date(b.createdAt).toLocaleString() : ""),
      requestFact("Reference", b.id),
    ]
      .filter(Boolean)
      .forEach(function (row) {
        facts.appendChild(row);
      });
    card.appendChild(facts);

    const actions = document.createElement("div");
    actions.className = "bkcard__actions";

    if (b.status === "pending") {
      if (String(tqConfirmingId) === String(b.id)) {
        const confirm = document.createElement("div");
        confirm.className = "bkconfirm";
        const q = document.createElement("p");
        q.className = "bkconfirm__text";
        q.textContent = "Decline this request? The student will see it as rejected.";
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "btn btn--ghost";
        yes.setAttribute("data-tqreject-yes", b.id);
        yes.innerHTML = '<span class="btn__label">Yes, decline request</span>';
        const no = document.createElement("button");
        no.type = "button";
        no.className = "btn btn--ghost";
        no.setAttribute("data-tqreject-no", b.id);
        no.innerHTML = '<span class="btn__label">Keep it pending</span>';
        confirm.appendChild(q);
        confirm.appendChild(yes);
        confirm.appendChild(no);
        actions.appendChild(confirm);
      } else {
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "btn btn--primary";
        accept.setAttribute("data-tqaccept", b.id);
        accept.innerHTML = '<span class="btn__label">Accept request</span>';
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "btn btn--ghost";
        reject.setAttribute("data-tqreject", b.id);
        reject.innerHTML = '<span class="btn__label">Decline request</span>';
        actions.appendChild(accept);
        actions.appendChild(reject);
      }
    } else {
      const note = document.createElement("p");
      note.className = "bkcard__note";
      if (b.rawStatus === "completed") {
        note.textContent = "You marked this lesson complete. The student can now review it.";
      } else if (b.status === "accepted") {
        note.textContent = "You accepted this request. The student now sees it as accepted.";
      } else if (b.status === "cancelled") {
        note.textContent = "The student cancelled this request.";
      } else {
        note.textContent = "You declined this request.";
      }
      actions.appendChild(note);

      // A lesson can only be completed once it has taken place. The server
      // refuses a future lesson, so the action is offered only afterwards.
      if (b.status === "accepted" && !b.completed && bookingHasPassed(b)) {
        const complete = document.createElement("button");
        complete.type = "button";
        complete.className = "btn btn--primary";
        complete.setAttribute("data-tqcomplete", b.id);
        complete.innerHTML = '<span class="btn__label">Mark lesson complete</span>';
        actions.appendChild(complete);
      }
    }
    card.appendChild(actions);
    return card;
  }

  function renderTeacherRequests() {
    const mine = teacherRequests();
    const counts = bookingCounts(mine);

    tqCountTotal.textContent = String(counts.all);
    tqCountPending.textContent = String(counts.pending);
    tqCountAccepted.textContent = String(counts.accepted);
    tqCountRejected.textContent = String(counts.rejected);
    tqCountCancelled.textContent = String(counts.cancelled);

    tqFilters.querySelectorAll("[data-tqfilter]").forEach(function (btn) {
      const key = btn.getAttribute("data-tqfilter");
      const active = key === tqFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
      btn.textContent = (key === "all" ? "All" : bookingStatusLabel(key)) + " (" + (counts[key] || 0) + ")";
    });

    const visible = (tqFilter === "all"
      ? mine.slice()
      : mine.filter(function (b) {
          return b.status === tqFilter;
        })
    ).sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    tqSummary.textContent = mine.length
      ? tqFilter === "all"
        ? mine.length + (mine.length === 1 ? " request in total." : " requests in total.")
        : visible.length + " of " + mine.length + " requests are " +
          bookingStatusLabel(tqFilter).toLowerCase() + "."
      : "No lesson requests yet.";

    tqList.innerHTML = "";
    visible.forEach(function (b) {
      tqList.appendChild(renderRequestCard(b));
    });

    if (!mine.length) {
      tqEmpty.hidden = false;
      tqEmptyTitle.textContent = "No lesson requests yet";
      tqEmptyText.textContent =
        "When a student requests a demo lesson from your profile, it will appear here for you to " +
        "accept or decline.";
      tqEmptyAction.hidden = true;
    } else if (!visible.length) {
      tqEmpty.hidden = false;
      tqEmptyTitle.textContent = "No " + bookingStatusLabel(tqFilter).toLowerCase() + " requests";
      tqEmptyText.textContent = "None of your requests have this status right now.";
      tqEmptyAction.hidden = false;
    } else {
      tqEmpty.hidden = true;
    }
    updateRequestsBadge();
  }

  // Accepting updates the ORIGINAL record; no new booking is created.
  function acceptRequest(id) {
    const record = bookings.filter(function (b) {
      return String(b.id) === String(id);
    })[0];
    if (!record) {
      showToast("That request could not be found.");
      return;
    }

    // FIX 9 — integration. This previously set record.status on the
    // in-memory array and toasted success without calling the API, so the
    // decision was lost on refresh.
    apiRequest("/bookings/" + encodeURIComponent(id) + "/accept", { method: "PATCH" })
      .then(function () { tqConfirmingId = ""; return loadBookings(); })
      .then(function () {
        renderTeacherRequests();
        refreshBookingViews();
        showToast("Request accepted.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  function rejectRequest(id, reason) {
    const record = bookings.filter(function (b) {
      return String(b.id) === String(id);
    })[0];
    if (!record) {
      showToast("That request could not be found.");
      return;
    }

    // FIX 9 — integration, see acceptRequest().
    apiRequest("/bookings/" + encodeURIComponent(id) + "/reject", {
      method: "PATCH",
      body: { reason: reason || "The teacher is unavailable at that time." },
    })
      .then(function () { tqConfirmingId = ""; return loadBookings(); })
      .then(function () {
        renderTeacherRequests();
        refreshBookingViews();
        showToast("Request declined.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  // Marking a lesson complete is a server decision: the API refuses a lesson
  // that has not happened yet and refuses anything that is not accepted.
  function completeLesson(id) {
    const record = bookings.filter(function (b) {
      return String(b.id) === String(id);
    })[0];
    if (!record) {
      showToast("That request could not be found.");
      return;
    }
    apiRequest("/bookings/" + encodeURIComponent(id) + "/complete", { method: "PATCH" })
      .then(function () { return loadBookings(); })
      .then(function () {
        renderTeacherRequests();
        refreshBookingViews();
        showToast("Lesson marked complete.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  tqFilters.addEventListener("click", function (event) {
    const btn = event.target.closest("[data-tqfilter]");
    if (!btn) return;
    tqFilter = btn.getAttribute("data-tqfilter");
    tqConfirmingId = "";
    renderTeacherRequests();
  });

  tqList.addEventListener("click", function (event) {
    const accept = event.target.closest("[data-tqaccept]");
    if (accept) {
      acceptRequest(accept.getAttribute("data-tqaccept"));
      return;
    }
    const reject = event.target.closest("[data-tqreject]");
    if (reject) {
      tqConfirmingId = reject.getAttribute("data-tqreject");
      renderTeacherRequests();
      return;
    }
    const no = event.target.closest("[data-tqreject-no]");
    if (no) {
      tqConfirmingId = "";
      renderTeacherRequests();
      return;
    }
    const yes = event.target.closest("[data-tqreject-yes]");
    if (yes) {
      rejectRequest(yes.getAttribute("data-tqreject-yes"));
      return;
    }
    const complete = event.target.closest("[data-tqcomplete]");
    if (complete) {
      completeLesson(complete.getAttribute("data-tqcomplete"));
    }
  });

  tqEmptyAction.addEventListener("click", function () {
    tqFilter = "all";
    renderTeacherRequests();
  });

  /* ========== Attendance (, Parts 1-3) ========================== */
  const attCountTotal = document.getElementById("att-count-total");
  const attCountPresent = document.getElementById("att-count-present");
  const attCountAbsent = document.getElementById("att-count-absent");
  const attCountPending = document.getElementById("att-count-pending");
  const attCountConfirmed = document.getElementById("att-count-confirmed");
  const attCountDisputed = document.getElementById("att-count-disputed");
  const attTodo = document.getElementById("att-todo");
  const attTodoSummary = document.getElementById("att-todo-summary");
  const attTodoEmpty = document.getElementById("att-todo-empty");
  const attTodoEmptyTitle = document.getElementById("att-todo-empty-title");
  const attTodoEmptyText = document.getElementById("att-todo-empty-text");
  const attFilters = document.getElementById("att-filters");
  const attSummary = document.getElementById("att-summary");
  const attList = document.getElementById("att-list");
  const attEmpty = document.getElementById("att-empty");
  const attEmptyTitle = document.getElementById("att-empty-title");
  const attEmptyText = document.getElementById("att-empty-text");
  const attEmptyAction = document.getElementById("att-empty-action");
  const attExport = document.getElementById("att-export");

  let attFilter = "all";
  let attAbsentFor = "";      // booking showing the absence-reason form
  let attDisputeFor = "";     // attendance record showing the dispute form
  let attCorrectionFor = "";  // attendance record showing the correction form
  let sattFilter = "all";

  /* ------------------------- CSV export ------------------------------- */
  // Formula injection: a cell that starts with = + - or @ is prefixed with an
  // apostrophe so a spreadsheet treats it as text, never as a formula.
  function csvCell(value) {
    let v = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    if (/[",\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function buildAttendanceCsv(records, view) {
    const header = [
      "Attendance ID", "Booking ID", "Lesson date", "Lesson time", "Subject", "Teaching mode",
      view === "teacher" ? "Student" : "Teacher",
      "Teacher result", "Current result", "Confirmation status", "Absence reason",
      "Student dispute", "Correction request", "Marked at",
    ];
    const rows = records.map(function (r) {
      const open = openCorrectionFor(r.id);
      return [
        r.id, r.bookingId, r.date, r.time, r.subject, r.modeLabel,
        view === "teacher" ? r.studentName : r.teacherName,
        ATTENDANCE_RESULT_LABELS[r.result] || r.result,
        ATTENDANCE_RESULT_LABELS[r.currentResult || r.result] || "",
        attendanceStatusLabel(r),
        r.absenceReason || "",
        r.studentResponse || "",
        open ? open.status + ": " + open.explanation : "",
        r.markedAt || "",
      ].map(csvCell).join(",");
    });
    // A UTF-8 BOM keeps non-ASCII names intact in Excel.
    return "\ufeff" + [header.map(csvCell).join(",")].concat(rows).join("\r\n");
  }

  function downloadCsv(text, filename) {
    try {
      const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1500);
      return true;
    } catch (err) {
      showToast("This environment blocked the download. The history is still shown on screen.");
      return false;
    }
  }

  /* ---------------------- attendance data access ---------------------- */
  function teacherAttendance() {
    const tId = currentTeacherId();
    if (!tId) return [];
    return attendance.filter(function (a) {
      return a.teacherId === tId;
    });
  }
  function studentAttendance() {
    const sId = currentStudentId();
    return attendance.filter(function (a) {
      return a.studentId === sId;
    });
  }
  // Accepted bookings that have not been marked yet. Completion is not tracked,
  // so an accepted booking is the only eligibility signal available.
  function teacherAttendanceTodo() {
    const tId = currentTeacherId();
    if (!tId) return [];
    return bookings
      .filter(function (b) {
        return b.teacherId === tId && b.status === "accepted" && !attendanceForBooking(b.id);
      })
      .sort(function (a, b) {
        return String(a.date + a.time).localeCompare(String(b.date + b.time));
      });
  }

  function attendanceCounts(list) {
    const counts = {
      total: list.length, present: 0, absent: 0,
      pending: 0, confirmed: 0, disputed: 0, review: 0,
    };
    list.forEach(function (r) {
      if (r.result === "present") counts.present += 1;
      if (r.result === "absent") counts.absent += 1;
      if (attendanceIsUnderReview(r)) counts.review += 1;
      if (Object.prototype.hasOwnProperty.call(counts, r.confirmation)) counts[r.confirmation] += 1;
    });
    return counts;
  }

  function attendanceFact(label, value) {
    if (!value) return null;
    const row = document.createElement("div");
    row.className = "bkcard__fact";
    const dt = document.createElement("p");
    dt.className = "bkcard__fact-label";
    dt.textContent = label;
    const dd = document.createElement("p");
    dd.className = "bkcard__fact-value";
    dd.textContent = value;
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  // Shared inline explanation form used for disputes and correction requests.
  function attendanceTextForm(record, title, inputId, placeholder, max, saveLabel, saveAttr, cancelAttr) {
    const wrap = document.createElement("div");
    wrap.className = "bkconfirm";
    const label = document.createElement("label");
    label.className = "field__label";
    label.setAttribute("for", inputId);
    label.textContent = title;
    const area = document.createElement("textarea");
    area.id = inputId;
    area.rows = 3;
    area.maxLength = max;
    area.className = "att-reason";
    area.placeholder = placeholder;
    const err = document.createElement("p");
    err.className = "field__error";
    err.id = inputId + "-error";
    err.setAttribute("role", "alert");
    err.hidden = true;
    const buttons = document.createElement("div");
    buttons.className = "att-reason-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn--primary";
    save.setAttribute(saveAttr, record.id);
    save.innerHTML = '<span class="btn__label">' + saveLabel + "</span>";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn--ghost";
    cancel.setAttribute(cancelAttr, record.id);
    cancel.innerHTML = '<span class="btn__label">Cancel</span>';
    buttons.appendChild(save);
    buttons.appendChild(cancel);
    wrap.appendChild(label);
    wrap.appendChild(area);
    wrap.appendChild(err);
    wrap.appendChild(buttons);
    return wrap;
  }

  // One shared card for both the teacher and student attendance views.
  function attendanceCard(record, view) {
    const card = document.createElement("article");
    card.className = "bkcard";
    card.setAttribute("data-attendance", record.id);

    const head = document.createElement("div");
    head.className = "bkcard__head";
    const avatar = document.createElement("div");
    avatar.className = "bkcard__avatar";
    const who = view === "teacher" ? record.studentName : record.teacherName;
    const initials = initialsFrom(who);
    if (initials) {
      avatar.textContent = initials;
      avatar.setAttribute("role", "img");
      avatar.setAttribute("aria-label", "Default avatar showing " + initials);
    } else {
      avatar.setAttribute("aria-hidden", "true");
      avatar.innerHTML = '<svg width="20" height="20" aria-hidden="true"><use href="#i-user" /></svg>';
    }
    const identity = document.createElement("div");
    identity.className = "bkcard__identity";
    const nameEl = document.createElement("h3");
    nameEl.className = "bkcard__teacher";
    nameEl.textContent = who || (view === "teacher" ? "Student (no name provided)" : "Teacher");
    identity.appendChild(nameEl);
    const metaEl = document.createElement("p");
    metaEl.className = "bkcard__meta";
    metaEl.textContent = [record.subject, record.modeLabel].filter(Boolean).join(" \u00b7 ");
    identity.appendChild(metaEl);

    const pill = document.createElement("span");
    pill.className = "status status--" + attendanceStatusClass(record);
    pill.textContent = attendanceStatusLabel(record);

    head.appendChild(avatar);
    head.appendChild(identity);
    head.appendChild(pill);
    card.appendChild(head);

    const facts = document.createElement("div");
    facts.className = "bkcard__facts";
    const corrected = record.currentResult && record.currentResult !== record.result;
    [
      attendanceFact("Lesson date", prettyDate(record.date)),
      attendanceFact("Lesson time", record.time),
      attendanceFact("Teacher recorded", ATTENDANCE_RESULT_LABELS[record.result] || record.result),
      corrected
        ? attendanceFact("Current result", ATTENDANCE_RESULT_LABELS[record.currentResult])
        : null,
      attendanceFact("Absence reason", record.absenceReason),
      attendanceFact("Student response", record.studentResponse),
      attendanceFact("Marked at", record.markedAt ? new Date(record.markedAt).toLocaleString() : ""),
      attendanceFact("Reference", record.id + " \u00b7 " + record.bookingId),
    ]
      .filter(Boolean)
      .forEach(function (row) {
        facts.appendChild(row);
      });
    card.appendChild(facts);

    // Open correction request, if any.
    const openCorrection = openCorrectionFor(record.id);
    const actions = document.createElement("div");
    actions.className = "bkcard__actions";

    if (openCorrection) {
      const note = document.createElement("p");
      note.className = "bkcard__note";
      note.textContent =
        "Correction request " + openCorrection.id + " from the " + openCorrection.requesterRole +
        " is " + (CORRECTION_STATUS_LABELS[openCorrection.status] || openCorrection.status) +
        ". It is waiting for the review console, so this record is on hold.";
      actions.appendChild(note);
    }

    // Final decisions, if any.
    const history = decisions.filter(function (d) {
      return d.attendanceId === record.id;
    });
    if (history.length) {
      const note = document.createElement("p");
      note.className = "bkcard__note";
      note.textContent =
        "Review decision: " + history[history.length - 1].decisionLabel + " \u2014 " +
        history[history.length - 1].reason;
      actions.appendChild(note);
    }

    if (view === "student" && !openCorrection) {
      if (attDisputeFor === record.id) {
        actions.appendChild(attendanceTextForm(
          record, "Dispute this record", "att-dispute-text-" + record.id,
          "Explain what you believe is wrong. This goes to the review console.",
          DISPUTE_TEXT_MAX, "Submit dispute", "data-attdispute-save", "data-attdispute-cancel"
        ));
      } else if (attCorrectionFor === record.id) {
        actions.appendChild(attendanceTextForm(
          record, "Request a correction", "att-correct-text-" + record.id,
          "Explain why this record should be corrected.",
          CORRECTION_TEXT_MAX, "Send correction request", "data-attcorrect-save", "data-attcorrect-cancel"
        ));
      } else if (record.confirmation === "pending") {
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "btn btn--primary";
        confirm.setAttribute("data-attconfirm", record.id);
        confirm.innerHTML = '<span class="btn__label">Confirm attendance</span>';
        const dispute = document.createElement("button");
        dispute.type = "button";
        dispute.className = "btn btn--ghost";
        dispute.setAttribute("data-attdispute", record.id);
        dispute.innerHTML = '<span class="btn__label">Dispute this</span>';
        actions.appendChild(confirm);
        actions.appendChild(dispute);
      } else {
        // Confirmed and disputed records can only move through a correction
        // request, so a dispute can never be confirmed away by the student.
        const correct = document.createElement("button");
        correct.type = "button";
        correct.className = "btn btn--ghost";
        correct.setAttribute("data-attcorrect", record.id);
        correct.innerHTML = '<span class="btn__label">Request a correction</span>';
        actions.appendChild(correct);
      }
    }

    if (view === "teacher" && !openCorrection) {
      if (attCorrectionFor === record.id) {
        actions.appendChild(attendanceTextForm(
          record, "Request a correction", "att-correct-text-" + record.id,
          "Explain why your entry should be corrected.",
          CORRECTION_TEXT_MAX, "Send correction request", "data-attcorrect-save", "data-attcorrect-cancel"
        ));
      } else {
        const correct = document.createElement("button");
        correct.type = "button";
        correct.className = "btn btn--ghost";
        correct.setAttribute("data-attcorrect", record.id);
        correct.innerHTML = '<span class="btn__label">Request a correction</span>';
        actions.appendChild(correct);
      }
    }

    card.appendChild(actions);
    return card;
  }

  /* ---------------------- teacher attendance view --------------------- */
  function attendanceTodoCard(booking) {
    const card = document.createElement("article");
    card.className = "bkcard";
    card.setAttribute("data-todo", booking.id);

    const head = document.createElement("div");
    head.className = "bkcard__head";
    const avatar = document.createElement("div");
    avatar.className = "bkcard__avatar";
    const initials = initialsFrom(booking.studentName);
    if (initials) {
      avatar.textContent = initials;
      avatar.setAttribute("role", "img");
      avatar.setAttribute("aria-label", "Default avatar showing " + initials);
    } else {
      avatar.setAttribute("aria-hidden", "true");
      avatar.innerHTML = '<svg width="20" height="20" aria-hidden="true"><use href="#i-user" /></svg>';
    }
    const identity = document.createElement("div");
    identity.className = "bkcard__identity";
    const nameEl = document.createElement("h3");
    nameEl.className = "bkcard__teacher";
    nameEl.textContent = booking.studentName || "Student (no name provided)";
    identity.appendChild(nameEl);
    const metaEl = document.createElement("p");
    metaEl.className = "bkcard__meta";
    metaEl.textContent = [booking.subject, booking.modeLabel].filter(Boolean).join(" \u00b7 ");
    identity.appendChild(metaEl);
    head.appendChild(avatar);
    head.appendChild(identity);
    const pill = document.createElement("span");
    pill.className = "status status--accepted";
    pill.textContent = "Accepted";
    head.appendChild(pill);
    card.appendChild(head);

    const facts = document.createElement("div");
    facts.className = "bkcard__facts";
    const passed = (booking.date + "T" + booking.time) <= localDateISO() + "T" + localTimeHM();
    [
      attendanceFact("Lesson date", prettyDate(booking.date)),
      attendanceFact("Lesson time", booking.time),
      attendanceFact("Timing", passed ? "Lesson date has passed" : "Scheduled in the future"),
      attendanceFact("Reference", booking.id),
    ]
      .filter(Boolean)
      .forEach(function (row) {
        facts.appendChild(row);
      });
    card.appendChild(facts);

    const actions = document.createElement("div");
    actions.className = "bkcard__actions";

    if (attAbsentFor === booking.id) {
      const form = document.createElement("div");
      form.className = "bkconfirm";
      const label = document.createElement("label");
      label.className = "field__label";
      label.setAttribute("for", "att-reason-" + booking.id);
      label.textContent = "Absence reason (optional)";
      const area = document.createElement("textarea");
      area.id = "att-reason-" + booking.id;
      area.rows = 2;
      area.maxLength = ABSENCE_REASON_MAX;
      area.className = "att-reason";
      area.placeholder = "e.g. The student did not join the lesson.";
      const buttons = document.createElement("div");
      buttons.className = "att-reason-actions";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "btn btn--primary";
      save.setAttribute("data-attmark-absent", booking.id);
      save.innerHTML = '<span class="btn__label">Record absence</span>';
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn--ghost";
      cancel.setAttribute("data-attmark-cancel", booking.id);
      cancel.innerHTML = '<span class="btn__label">Cancel</span>';
      buttons.appendChild(save);
      buttons.appendChild(cancel);
      form.appendChild(label);
      form.appendChild(area);
      form.appendChild(buttons);
      actions.appendChild(form);
    } else {
      const present = document.createElement("button");
      present.type = "button";
      present.className = "btn btn--primary";
      present.setAttribute("data-attmark-present", booking.id);
      present.innerHTML = '<span class="btn__label">Mark present</span>';
      const absent = document.createElement("button");
      absent.type = "button";
      absent.className = "btn btn--ghost";
      absent.setAttribute("data-attmark-absent-start", booking.id);
      absent.innerHTML = '<span class="btn__label">Mark absent</span>';
      actions.appendChild(present);
      actions.appendChild(absent);
    }
    card.appendChild(actions);
    return card;
  }

  // Marking is idempotent: a booking can only ever have one attendance record,
  // and the confirmation status always starts as pending.
  function markAttendance(bookingId, result, reason) {
    // FIX 9 — integration. This used to push an attendance record into
    // the in-memory array only; the lesson outcome was never stored.
    // The reason is sent exactly as it was typed. A placeholder used to be
    // substituted for an empty one, which meant the server never saw that no
    // reason had been given: the platform rule that a missed lesson needs an
    // explanation was never applied, and the record carried a reason the
    // teacher had not written. The server decides, and its answer is shown.
    apiRequest("/attendance", {
      method: "POST",
      body: {
        booking_id: Number(bookingId),
        result: result,
        reason: result === "absent" ? (reason || "") : null,
      },
    })
      .then(function () { return loadAttendance(); })
      .then(function () {
        renderTeacherAttendance();
        refreshBookingViews();
        showToast(result === "absent" ? "Marked absent." : "Marked present.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  function renderTeacherAttendance() {
    const mine = teacherAttendance();
    const counts = attendanceCounts(mine);
    attCountTotal.textContent = String(counts.total);
    attCountPresent.textContent = String(counts.present);
    attCountAbsent.textContent = String(counts.absent);
    attCountPending.textContent = String(counts.pending);
    attCountConfirmed.textContent = String(counts.confirmed);
    attCountDisputed.textContent = String(counts.disputed);

    const todo = teacherAttendanceTodo();
    attTodoSummary.textContent = todo.length
      ? todo.length + (todo.length === 1 ? " lesson is waiting to be marked." : " lessons are waiting to be marked.")
      : "Every accepted booking has an attendance record.";
    attTodo.innerHTML = "";
    todo.forEach(function (b) {
      attTodo.appendChild(attendanceTodoCard(b));
    });
    attTodoEmpty.hidden = todo.length > 0;
    attTodoEmptyTitle.textContent = mine.length ? "Nothing waiting to be marked" : "No accepted lessons yet";
    attTodoEmptyText.textContent = mine.length
      ? "All of your accepted bookings already have an attendance record."
      : "Once you accept a lesson request, that lesson appears here so you can record attendance.";

    const visible = attFilter === "all"
      ? mine.slice()
      : mine.filter(function (r) {
          if (attFilter === "present" || attFilter === "absent") return r.result === attFilter;
          return r.confirmation === attFilter;
        }).sort(function (a, b) {
          return String(b.date + b.time).localeCompare(String(a.date + a.time));
        });
    if (attFilter === "all") {
      visible.sort(function (a, b) {
        return String(b.date + b.time).localeCompare(String(a.date + a.time));
      });
    }

    attFilters.querySelectorAll("[data-attfilter]").forEach(function (btn) {
      const key = btn.getAttribute("data-attfilter");
      const active = key === attFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    attSummary.textContent = mine.length
      ? visible.length + " of " + mine.length + " record" + (mine.length === 1 ? "" : "s") + " shown."
      : "No attendance has been recorded yet.";

    attList.innerHTML = "";
    visible.forEach(function (r) {
      attList.appendChild(attendanceCard(r, "teacher"));
    });
    if (!visible.length) {
      attEmpty.hidden = false;
      attEmptyTitle.textContent = mine.length ? "No records match this filter" : "No attendance recorded yet";
      attEmptyText.textContent = mine.length
        ? "Try a different filter to see other records."
        : "Mark a lesson above and it will appear here with its confirmation status.";
      attEmptyAction.hidden = !mine.length;
    } else {
      attEmpty.hidden = true;
    }
    attExport.hidden = !visible.length;
  }

  attFilters.addEventListener("click", function (event) {
    const btn = event.target.closest("[data-attfilter]");
    if (!btn) return;
    attFilter = btn.getAttribute("data-attfilter");
    attAbsentFor = "";
    renderTeacherAttendance();
  });
  attEmptyAction.addEventListener("click", function () {
    attFilter = "all";
    renderTeacherAttendance();
  });
  attTodo.addEventListener("click", function (event) {
    const present = event.target.closest("[data-attmark-present]");
    if (present) {
      markAttendance(present.getAttribute("data-attmark-present"), "present", "");
      return;
    }
    const start = event.target.closest("[data-attmark-absent-start]");
    if (start) {
      attAbsentFor = start.getAttribute("data-attmark-absent-start");
      renderTeacherAttendance();
      const area = document.getElementById("att-reason-" + attAbsentFor);
      if (area) area.focus();
      return;
    }
    const save = event.target.closest("[data-attmark-absent]");
    if (save) {
      const id = save.getAttribute("data-attmark-absent");
      const area = document.getElementById("att-reason-" + id);
      markAttendance(id, "absent", area ? area.value : "");
      return;
    }
    const cancel = event.target.closest("[data-attmark-cancel]");
    if (cancel) {
      attAbsentFor = "";
      renderTeacherAttendance();
    }
  });
  /* ---------------------- student attendance view --------------------- */
  const sattCountTotal = document.getElementById("satt-count-total");
  const sattCountPending = document.getElementById("satt-count-pending");
  const sattCountConfirmed = document.getElementById("satt-count-confirmed");
  const sattCountDisputed = document.getElementById("satt-count-disputed");
  const sattFilters = document.getElementById("satt-filters");
  const sattSummary = document.getElementById("satt-summary");
  const sattList = document.getElementById("satt-list");
  const sattEmpty = document.getElementById("satt-empty");
  const sattEmptyTitle = document.getElementById("satt-empty-title");
  const sattEmptyText = document.getElementById("satt-empty-text");
  const sattEmptyAction = document.getElementById("satt-empty-action");
  const sattExport = document.getElementById("satt-export");

  function renderStudentAttendance() {
    const mine = studentAttendance();
    sattCountTotal.textContent = String(mine.length);
    sattCountPending.textContent = String(mine.filter(function (r) { return r.confirmation === "pending"; }).length);
    sattCountConfirmed.textContent = String(mine.filter(function (r) { return r.confirmation === "confirmed"; }).length);
    sattCountDisputed.textContent = String(mine.filter(function (r) { return r.confirmation === "disputed"; }).length);

    const visible = (sattFilter === "all"
      ? mine.slice()
      : mine.filter(function (r) {
          return r.confirmation === sattFilter;
        })
    ).sort(function (a, b) {
      return String(b.date + b.time).localeCompare(String(a.date + a.time));
    });

    sattFilters.querySelectorAll("[data-sattfilter]").forEach(function (btn) {
      const key = btn.getAttribute("data-sattfilter");
      const active = key === sattFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
      const count = key === "all" ? mine.length : mine.filter(function (r) { return r.confirmation === key; }).length;
      const base = key === "all" ? "All" : ATTENDANCE_CONFIRMATION_LABELS[key];
      btn.textContent = base + " (" + count + ")";
    });

    sattSummary.textContent = mine.length
      ? visible.length + " of " + mine.length + " record" + (mine.length === 1 ? "" : "s") + " shown."
      : "No attendance has been recorded for you yet.";

    sattList.innerHTML = "";
    visible.forEach(function (r) {
      sattList.appendChild(attendanceCard(r, "student"));
    });
    if (!visible.length) {
      sattEmpty.hidden = false;
      sattEmptyTitle.textContent = mine.length ? "Nothing with this status" : "No attendance records yet";
      sattEmptyText.textContent = mine.length
        ? "You have no records with this status right now."
        : "Once a teacher records attendance for one of your accepted lessons, it appears here for you to confirm.";
      sattEmptyAction.hidden = !mine.length;
    } else {
      sattEmpty.hidden = true;
    }
    sattExport.hidden = !visible.length;
  }

  // Confirming preserves the teacher's original result and only moves the
  // confirmation status.
  function confirmAttendance(id) {
    // FIX 9 — the confirmation is now sent to the server.
    apiRequest("/attendance/" + encodeURIComponent(id) + "/confirm", { method: "PATCH" })
      .then(function () { return loadAttendance(); })
      .then(function () {
        renderStudentAttendance();
        refreshBookingViews();
        showToast("Attendance confirmed.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  function disputeAttendance(id, text) {
    // FIX 9 — the dispute is now sent to the server.
    apiRequest("/attendance/" + encodeURIComponent(id) + "/dispute", {
      method: "PATCH",
      body: { response: text },
    })
      .then(function () { return loadAttendance(); })
      .then(function () {
        renderStudentAttendance();
        refreshBookingViews();
        showToast("Attendance disputed.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  // A correction request never changes the record by itself — it is queued.
  function requestCorrection(id, text, role) {
    // FIX 9 — corrections are now sent to the server.
    apiRequest("/attendance/" + encodeURIComponent(id) + "/corrections", {
      method: "POST",
      body: { explanation: text },
    })
      .then(function () { return loadAttendance(); })
      .then(function () {
        renderStudentAttendance();
        renderTeacherAttendance();
        refreshBookingViews();
        showToast("Correction requested.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  sattFilters.addEventListener("click", function (event) {
    const btn = event.target.closest("[data-sattfilter]");
    if (!btn) return;
    sattFilter = btn.getAttribute("data-sattfilter");
    attDisputeFor = "";
    attCorrectionFor = "";
    renderStudentAttendance();
  });
  sattEmptyAction.addEventListener("click", function () {
    sattFilter = "all";
    renderStudentAttendance();
  });
  sattList.addEventListener("click", function (event) {
    let el = event.target.closest("[data-attconfirm]");
    if (el) { confirmAttendance(el.getAttribute("data-attconfirm")); return; }
    el = event.target.closest("[data-attdispute]");
    if (el) {
      attDisputeFor = el.getAttribute("data-attdispute");
      attCorrectionFor = "";
      renderStudentAttendance();
      const area = document.getElementById("att-dispute-text-" + attDisputeFor);
      if (area) area.focus();
      return;
    }
    el = event.target.closest("[data-attdispute-cancel]");
    if (el) { attDisputeFor = ""; renderStudentAttendance(); return; }
    el = event.target.closest("[data-attdispute-save]");
    if (el) {
      const id = el.getAttribute("data-attdispute-save");
      const area = document.getElementById("att-dispute-text-" + id);
      disputeAttendance(id, area ? area.value : "");
      return;
    }
    el = event.target.closest("[data-attcorrect]");
    if (el) {
      attCorrectionFor = el.getAttribute("data-attcorrect");
      attDisputeFor = "";
      renderStudentAttendance();
      const area = document.getElementById("att-correct-text-" + attCorrectionFor);
      if (area) area.focus();
      return;
    }
    el = event.target.closest("[data-attcorrect-cancel]");
    if (el) { attCorrectionFor = ""; renderStudentAttendance(); return; }
    el = event.target.closest("[data-attcorrect-save]");
    if (el) {
      const id = el.getAttribute("data-attcorrect-save");
      const area = document.getElementById("att-correct-text-" + id);
      requestCorrection(id, area ? area.value : "", "student");
    }
  });
  sattExport.addEventListener("click", function () {
    const mine = studentAttendance();
    const visible = sattFilter === "all"
      ? mine
      : mine.filter(function (r) { return r.confirmation === sattFilter; });
    if (!visible.length) { showToast("There is nothing to export with this filter."); return; }
    downloadCsv(buildAttendanceCsv(visible, "student"), "theeduwalwa-my-attendance.csv");
  });

  attList.addEventListener("click", function (event) {
    const start = event.target.closest("[data-attcorrect]");
    if (start) {
      attCorrectionFor = start.getAttribute("data-attcorrect");
      renderTeacherAttendance();
      const area = document.getElementById("att-correct-text-" + attCorrectionFor);
      if (area) area.focus();
      return;
    }
    const cancel = event.target.closest("[data-attcorrect-cancel]");
    if (cancel) { attCorrectionFor = ""; renderTeacherAttendance(); return; }
    const save = event.target.closest("[data-attcorrect-save]");
    if (save) {
      const id = save.getAttribute("data-attcorrect-save");
      const area = document.getElementById("att-correct-text-" + id);
      requestCorrection(id, area ? area.value : "", "teacher");
    }
  });

  /* ========== Review console (, Part 4) ======================== */
  const rcFilters = document.getElementById("rc-filters");
  const rcSummary = document.getElementById("rc-summary");
  const rcCases = document.getElementById("rc-cases");
  const rcEmpty = document.getElementById("rc-empty");
  const rcEmptyTitle = document.getElementById("rc-empty-title");
  const rcEmptyText = document.getElementById("rc-empty-text");
  const rcAudit = document.getElementById("rc-audit");
  const rcAuditEmpty = document.getElementById("rc-audit-empty");
  const rcPolicyType = document.getElementById("rc-policy-type");
  const rcPolicyThreshold = document.getElementById("rc-policy-threshold");
  const rcPolicySave = document.getElementById("rc-policy-save");
  const rcPolicyState = document.getElementById("rc-policy-state");
  const rcBack = document.getElementById("rc-back");

  let rcFilter = "all";
  let rcReasonFor = "";   // case showing the reason form
  let rcReasonText = "";  // kept so the confirm step cannot lose the reason
  let rcPending = null;   // { id, type } awaiting confirmation

  function reviewCases() {
    return attendance.filter(function (a) {
      return a.confirmation === "disputed" || !!openCorrectionFor(a.id);
    }).sort(function (a, b) {
      return String(b.date + b.time).localeCompare(String(a.date + a.time));
    });
  }

  const DECISION_LABELS = {
    uphold: "Original attendance upheld",
    "approve-correction": "Correction approved",
    "reject-correction": "Correction request rejected",
    "keep-pending": "Left pending for more information",
  };

  function caseCard(record) {
    const card = document.createElement("article");
    card.className = "bkcard";
    card.setAttribute("data-case", record.id);

    const head = document.createElement("div");
    head.className = "bkcard__head";
    const identity = document.createElement("div");
    identity.className = "bkcard__identity";
    const title = document.createElement("h3");
    title.className = "bkcard__teacher";
    title.textContent = (record.studentName || "Student") + " \u00b7 " + (record.teacherName || "Teacher");
    identity.appendChild(title);
    const meta = document.createElement("p");
    meta.className = "bkcard__meta";
    meta.textContent = [record.subject, record.modeLabel].filter(Boolean).join(" \u00b7 ");
    identity.appendChild(meta);
    head.appendChild(identity);
    const pill = document.createElement("span");
    pill.className = "status status--" + attendanceStatusClass(record);
    pill.textContent = attendanceStatusLabel(record);
    head.appendChild(pill);
    card.appendChild(head);

    const open = openCorrectionFor(record.id);
    const facts = document.createElement("div");
    facts.className = "bkcard__facts";
    [
      attendanceFact("Lesson date", prettyDate(record.date)),
      attendanceFact("Teacher recorded", ATTENDANCE_RESULT_LABELS[record.result] || record.result),
      attendanceFact("Current result", ATTENDANCE_RESULT_LABELS[record.currentResult || record.result]),
      attendanceFact("Absence reason", record.absenceReason),
      attendanceFact("Student dispute", record.studentResponse),
      open ? attendanceFact("Correction " + open.id + " (" + open.requesterRole + ")", open.explanation) : null,
      attendanceFact("References", record.id + " \u00b7 " + record.bookingId),
    ].filter(Boolean).forEach(function (row) { facts.appendChild(row); });
    card.appendChild(facts);

    // Previous decisions on this record.
    const prior = decisions.filter(function (d) { return d.attendanceId === record.id; });
    if (prior.length) {
      const note = document.createElement("p");
      note.className = "bkcard__note";
      note.textContent = "Previous decision: " + prior[prior.length - 1].decisionLabel + " \u2014 " + prior[prior.length - 1].reason;
      card.appendChild(note);
    }

    const actions = document.createElement("div");
    actions.className = "bkcard__actions";

    if (rcPending && rcPending.id === record.id) {
      const confirm = document.createElement("div");
      confirm.className = "bkconfirm";
      const q = document.createElement("p");
      q.className = "bkconfirm__text";
      q.textContent = "Apply \u201c" + DECISION_LABELS[rcPending.type] + "\u201d? The original teacher entry is kept either way.";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "btn btn--primary";
      yes.setAttribute("data-rcapply", record.id);
      yes.innerHTML = '<span class="btn__label">Yes, apply decision</span>';
      const no = document.createElement("button");
      no.type = "button";
      no.className = "btn btn--ghost";
      no.setAttribute("data-rccancel", record.id);
      no.innerHTML = '<span class="btn__label">Cancel</span>';
      confirm.appendChild(q);
      confirm.appendChild(yes);
      confirm.appendChild(no);
      actions.appendChild(confirm);
    } else if (rcReasonFor === record.id) {
      const form = document.createElement("div");
      form.className = "bkconfirm";
      const label = document.createElement("label");
      label.className = "field__label";
      label.setAttribute("for", "rc-reason-" + record.id);
      label.textContent = "Decision reason (required)";
      const area = document.createElement("textarea");
      area.id = "rc-reason-" + record.id;
      area.rows = 3;
      area.maxLength = 400;
      area.className = "att-reason";
      area.placeholder = "Explain the decision for the record.";
      area.value = rcReasonText;
      const err = document.createElement("p");
      err.className = "field__error";
      err.id = "rc-reason-" + record.id + "-error";
      err.setAttribute("role", "alert");
      err.hidden = true;
      const buttons = document.createElement("div");
      buttons.className = "att-reason-actions";
      [["uphold", "Uphold original"], ["approve-correction", "Approve correction"], ["reject-correction", "Reject request"], ["keep-pending", "Leave pending"]]
        .forEach(function (pair) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn " + (pair[0] === "uphold" ? "btn--primary" : "btn--ghost");
          b.setAttribute("data-rcdecide", pair[0]);
          b.setAttribute("data-rccase", record.id);
          b.innerHTML = '<span class="btn__label">' + pair[1] + "</span>";
          buttons.appendChild(b);
        });
      form.appendChild(label);
      form.appendChild(area);
      form.appendChild(err);
      form.appendChild(buttons);
      actions.appendChild(form);
    } else {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn btn--primary";
      openBtn.setAttribute("data-rcopen", record.id);
      openBtn.innerHTML = '<span class="btn__label">Review this case</span>';
      actions.appendChild(openBtn);
    }
    card.appendChild(actions);
    return card;
  }

  function auditCard(d) {
    const card = document.createElement("article");
    card.className = "bkcard";
    card.setAttribute("data-decision", d.id);
    const head = document.createElement("div");
    head.className = "bkcard__head";
    const identity = document.createElement("div");
    identity.className = "bkcard__identity";
    const title = document.createElement("h3");
    title.className = "bkcard__teacher";
    title.textContent = d.decisionLabel;
    identity.appendChild(title);
    const meta = document.createElement("p");
    meta.className = "bkcard__meta";
    meta.textContent = d.decidedAt ? new Date(d.decidedAt).toLocaleString() : "";
    identity.appendChild(meta);
    head.appendChild(identity);
    card.appendChild(head);
    const facts = document.createElement("div");
    facts.className = "bkcard__facts";
    [
      attendanceFact("Reason", d.reason),
      attendanceFact("Original result", ATTENDANCE_RESULT_LABELS[d.originalResult] || d.originalResult),
      attendanceFact("Final result", ATTENDANCE_RESULT_LABELS[d.finalResult] || d.finalResult),
      attendanceFact("Reviewer", d.reviewerId),
      attendanceFact("References", d.id + " \u00b7 " + d.attendanceId + " \u00b7 " + d.bookingId + (d.correctionId ? " \u00b7 " + d.correctionId : "")),
    ].filter(Boolean).forEach(function (row) { facts.appendChild(row); });
    card.appendChild(facts);
    return card;
  }

  function renderReviewConsole() {
    const all = reviewCases();
    const visible = rcFilter === "disputed"
      ? all.filter(function (a) { return a.confirmation === "disputed"; })
      : rcFilter === "corrections"
      ? all.filter(function (a) { return !!openCorrectionFor(a.id); })
      : all;

    rcFilters.querySelectorAll("[data-rcfilter]").forEach(function (btn) {
      const key = btn.getAttribute("data-rcfilter");
      const active = key === rcFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    rcSummary.textContent = all.length
      ? visible.length + " of " + all.length + " case" + (all.length === 1 ? "" : "s") + " shown."
      : "Nothing needs a review decision right now.";

    rcCases.innerHTML = "";
    visible.forEach(function (r) { rcCases.appendChild(caseCard(r)); });
    rcEmpty.hidden = visible.length > 0;
    rcEmptyTitle.textContent = all.length ? "No cases with this filter" : "No cases waiting";
    rcEmptyText.textContent = all.length
      ? "Try a different filter to see other cases."
      : "Disputed records and correction requests appear here once a student or teacher raises one.";

    const log = decisions.slice().sort(function (a, b) {
      return String(b.decidedAt).localeCompare(String(a.decidedAt));
    });
    rcAudit.innerHTML = "";
    log.forEach(function (d) { rcAudit.appendChild(auditCard(d)); });
    rcAuditEmpty.hidden = log.length > 0;

    renderPolicyState();
  }

  function renderPolicyState() {
    rcPolicyType.value = reviewPolicy.configured ? reviewPolicy.type : "";
    rcPolicyThreshold.value = reviewPolicy.configured ? String(reviewPolicy.minConfirmedDays) : "";
    rcPolicyState.textContent = reviewPolicy.configured
      ? "Active policy: " + (POLICY_TYPES[reviewPolicy.type] || reviewPolicy.type) +
        ", minimum " + reviewPolicy.minConfirmedDays + "."
      : "No policy is configured, so review eligibility cannot be determined and reviews stay locked.";
  }

  // A decision is recorded by the server. The server appends the immutable
  // decision row, updates the record, notifies both parties and writes the
  // audit entry; the original teacher-marked result is never overwritten.
  async function decideCase(attendanceId, type, reason) {
    const record = attendance.filter(function (a) { return a.id === attendanceId; })[0];
    if (!record) { showToast("That case could not be found."); return; }
    const clean = String(reason || "").trim();
    if (!clean) {
      const err = document.getElementById("rc-reason-" + attendanceId + "-error");
      if (err) { err.textContent = "A decision reason is required."; err.hidden = false; }
      return;
    }
    if (clean.length < 3) {
      const err = document.getElementById("rc-reason-" + attendanceId + "-error");
      if (err) { err.textContent = "Give a reason of at least 3 characters."; err.hidden = false; }
      return;
    }

    const openCorrection = openCorrectionFor(record.id);
    const body = { decision_type: type, reason: clean };
    if (openCorrection && openCorrection.id) body.correction_id = openCorrection.id;

    try {
      await apiRequest("/admin/attendance/" + encodeURIComponent(attendanceId) + "/decisions", {
        method: "POST",
        body: body,
      });
      rcPending = null;
      rcReasonFor = "";
      rcReasonText = "";
      await Promise.allSettled([loadAttendance(), loadNotifications()]);
      await refreshAdminAudit();
      renderReviewConsole();
      refreshBookingViews();
      showToast(DECISION_LABELS[type] + ".");
    } catch (error) {
      const err = document.getElementById("rc-reason-" + attendanceId + "-error");
      if (err) { err.textContent = apiErrorMessage(error); err.hidden = false; }
      showToast(apiErrorMessage(error));
    }
  }

  rcFilters.addEventListener("click", function (event) {
    const btn = event.target.closest("[data-rcfilter]");
    if (!btn) return;
    rcFilter = btn.getAttribute("data-rcfilter");
    rcPending = null; rcReasonFor = "";
    renderReviewConsole();
  });
  rcCases.addEventListener("click", function (event) {
    let el = event.target.closest("[data-rcopen]");
    if (el) { rcReasonFor = el.getAttribute("data-rcopen"); rcPending = null; rcReasonText = ""; renderReviewConsole();
      const a = document.getElementById("rc-reason-" + rcReasonFor); if (a) a.focus(); return; }
    el = event.target.closest("[data-rcdecide]");
    if (el) {
      const id = el.getAttribute("data-rccase");
      const area = document.getElementById("rc-reason-" + id);
      const err = document.getElementById("rc-reason-" + id + "-error");
      const clean = area ? area.value.trim() : "";
      if (!clean) {
        if (err) { err.textContent = "A decision reason is required."; err.hidden = false; }
        if (area) area.focus();
        return;
      }
      rcReasonText = clean;
      rcPending = { id: id, type: el.getAttribute("data-rcdecide") };
      renderReviewConsole();
      return;
    }
    el = event.target.closest("[data-rccancel]");
    if (el) { rcPending = null; renderReviewConsole(); return; }
    el = event.target.closest("[data-rcapply]");
    if (el && rcPending) {
      // The confirm step re-rendered the card, so the reason is read from the
      // variable captured when the decision was chosen.
      decideCase(el.getAttribute("data-rcapply"), rcPending.type, rcReasonText);
    }
  });
  rcPolicySave.addEventListener("click", function () {
    // FIX (D2) — integration. This used to set reviewPolicy.* on the
    // in-memory object and toast "Policy saved." without calling the API, so the
    // policy was never stored: the server kept reporting "not configured" while
    // the console claimed success. It now persists via saveSettingsGroups() —
    // the same path the other settings screens use.
    const type = rcPolicyType.value;
    const threshold = Number(rcPolicyThreshold.value);
    const applyLocal = function () {
      renderReviewConsole();
      refreshBookingViews();
    };

    if (!type) {
      saveSettingsGroups({
        eligibility: { configured: false, type: "study-days", minConfirmedDays: 0, minCompletedLessons: 0 },
      })
        .then(function () {
          applyLocal();
          showToast("Policy cleared. Reviews stay locked until a policy is set.");
        })
        .catch(function (error) { showToast(apiErrorMessage(error)); });
      return;
    }
    if (!Number.isInteger(threshold) || threshold < 1) {
      showToast("Enter a whole number of at least 1 for the minimum count.");
      return;
    }
    saveSettingsGroups({
      eligibility: {
        configured: true,
        type: type,
        minConfirmedDays: type === "study-days" ? threshold : 0,
        minCompletedLessons: type === "completed-lessons" ? threshold : 0,
      },
    })
      .then(function () {
        applyLocal();
        showToast("Policy saved. Eligibility is recalculated from the real records.");
      })
      .catch(function (error) { showToast(apiErrorMessage(error)); });
  });
  rcBack.addEventListener("click", function () { navigate("login"); });

  const attExportXlsx = document.getElementById("att-export-xlsx");
  const attExportPdf = document.getElementById("att-export-pdf");
  const sattExportXlsx = document.getElementById("satt-export-xlsx");
  const sattExportPdf = document.getElementById("satt-export-pdf");
  function teacherFilteredAttendance() {
    const mine = teacherAttendance();
    if (attFilter === "all") return mine;
    return mine.filter(function (r) {
      if (attFilter === "present" || attFilter === "absent") return r.result === attFilter;
      return r.confirmation === attFilter;
    });
  }
  function studentFilteredAttendance() {
    const mine = studentAttendance();
    if (sattFilter === "all") return mine;
    return mine.filter(function (r) { return r.confirmation === sattFilter; });
  }
  if (attExportXlsx) attExportXlsx.addEventListener("click", function () {
    exportAttendance(teacherFilteredAttendance(), "teacher", "xlsx");
  });
  if (attExportPdf) attExportPdf.addEventListener("click", function () {
    exportAttendance(teacherFilteredAttendance(), "teacher", "pdf");
  });
  if (sattExportXlsx) sattExportXlsx.addEventListener("click", function () {
    exportAttendance(studentFilteredAttendance(), "student", "xlsx");
  });
  if (sattExportPdf) sattExportPdf.addEventListener("click", function () {
    exportAttendance(studentFilteredAttendance(), "student", "pdf");
  });

  attExport.addEventListener("click", function () {
    const mine = teacherAttendance();
    const visible = attFilter === "all"
      ? mine
      : mine.filter(function (r) {
          if (attFilter === "present" || attFilter === "absent") return r.result === attFilter;
          return r.confirmation === attFilter;
        });
    if (!visible.length) {
      showToast("There is nothing to export with this filter.");
      return;
    }
    downloadCsv(buildAttendanceCsv(visible, "teacher"), "attendance.csv");
  });

  
  // ONE centralized settings object. Global defaults live in `platformSettings`;
  // per-teacher overrides live in `teacherOverrides`; `effectiveSettings()`
  // resolves the two so no screen has to know about precedence. Everything is
  // loaded from the settings API and kept in sync with it.
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  const SETTINGS_DEFAULTS = {
    general: {
      appName: "EduPlatform",
      supportSignup: true,
      teacherApprovalRequired: false,
      requireTeacherDocumentVerification: true,
      maintenanceMode: false,
      defaultLanguage: "English",
    },
    attendance: {
      verificationEnabled: true,
      method: "teacher-and-student",
      requireOtp: false,
      otpExpiryMinutes: 10,
      otpMaxAttempts: 3,
      onMissingConfirmation: "leave-pending",
      onConflictingConfirmation: "flag-for-review",
      requireReasonWhenLessonMissed: true,
      disputesRequireAdminReview: true,
    },
    whatsapp: {
      enabled: false,
      provider: "meta-cloud-api",
      phoneNumberId: "",
      businessAccountId: "",
      testRecipient: "",
      credentialSource: "server-environment",
      lastTestStatus: "not-configured",
    },
    otp: {
      enabled: true,
      requireRegistrationOtp: false,
      requirePasswordResetOtp: true,
      channel: "whatsapp",
      otpExpiryMinutes: 10,
      otpMaxAttempts: 5,
    },
    holidays: {
      platform: [],
      blockNewBookings: true,
      existingBookingsPolicy: "flag-and-review",
    },
    eligibility: {
      configured: false,
      type: "study-days",
      minConfirmedDays: 0,
      minCompletedLessons: 0,
      requireCompletedBooking: true,
      countDisputedAttendance: false,
      countUnconfirmedAttendance: false,
      maxReviewsPerLesson: 1,
    },
    pricing: {
      hourly: { enabled: true, mode: "optional" },
      monthly: { enabled: false, mode: "optional" },
      course: { enabled: false, mode: "optional" },
    },
    terms: { common: null, student: null, teacher: null },
    contact: {
      enabled: true,
      title: "Contact & support",
      message: "",
      email: "",
      phone: "",
      whatsapp: "",
      hours: "",
      showEmail: true,
      showPhone: true,
      showWhatsapp: true,
    },
    branding: { appName: "EduPlatform", tagline: "", logo: null, logo2: null, favicon: null },
  };

  const platformSettings = deepClone(SETTINGS_DEFAULTS);
  const teacherOverrides = {};   // teacherId -> { attendance:{}, pricing:{}, eligibility:{} }
  const adminAudit = [];
  const adminSession = { role: "admin" }; // set from the authenticated /me response
  let adminSection = "overview";
  let adminDataOverview = null;
  let adminDataTable = "";
  let adminDataSearch = "";
  let adminDataResult = null;
  let adminBackupDirectory = "";
  let adminBackupRoot = "internal";
  let adminDataFolderBrowse = null;
  let adminDataFolderOpen = false;
  let adminStorageDashboard = null;
  let adminStorageProviders = [];
  let adminStorageTestingKey = null;

  // The admin panel holds a snapshot of the data that was loaded when the
  // administrator signed in. A request that arrives later - a student
  // booking a lesson, a colleague doing something - is not in that snapshot
  // until the data is loaded again.
  let adminDataLoadedAt = 0;
  let adminRefreshing = false;

  /* admin-refresh:start */
  // The sections that hold a form. Reloading one of them would throw away
  // the changes the administrator has made but not saved, so they are never
  // re-rendered without asking first.
  const ADMIN_FORM_SECTIONS = [
    "settings", "eligibility", "pricing", "terms", "contact", "branding", "roles", "notifications", "data",
  ];

  // How long a load stays fresh. Coming back to the panel within this window
  // does not ask the server for the same records again.
  const ADMIN_FRESH_MS = 20000;

  /**
   * Decides what a refresh of the admin panel does.
   *
   * The rule is pure, so it can be exercised on its own:
   *  - a load that just happened is not repeated (no duplicate requests);
   *  - a background refresh never redraws a section that holds a form, so
   *    unsaved edits are not thrown away;
   *  - an explicit refresh asks before it redraws such a section.
   *
   * @param {{section: string, loadedAt: number, now: number, refreshing?: boolean}} state
   * @param {{force?: boolean, agreed?: boolean}} options
   * @returns {{refresh: boolean, rerender: boolean, ask: boolean, reason: string}}
   */
  function adminRefreshDecision(state, options) {
    const opts = options || {};
    if (state.refreshing) {
      return { refresh: false, rerender: false, ask: false, reason: "a refresh is already running" };
    }

    const isForm = ADMIN_FORM_SECTIONS.indexOf(state.section) !== -1;

    // An explicit refresh of a section that holds a form asks first.
    if (opts.force && isForm && !opts.agreed) {
      return { refresh: false, rerender: false, ask: true, reason: "the section holds unsaved edits" };
    }

    // A load that just happened is still fresh, so coming back to the panel
    // does not ask the server for the same data twice.
    if (!opts.force && state.now - state.loadedAt < ADMIN_FRESH_MS) {
      return { refresh: false, rerender: false, ask: false, reason: "the data was loaded moments ago" };
    }

    return {
      refresh: true,
      // A form section keeps what the administrator has typed: the data behind
      // it is fresh, and the next save sends what is on the screen.
      rerender: opts.force || !isForm,
      ask: false,
      reason: opts.force ? "the refresh was asked for" : "the data has gone stale",
    };
  }
  /* admin-refresh:end */

  /**
   * Loads the admin data again.
   *
   * @param {{force?: boolean}} options
   * @returns {Promise<boolean>}
   */
  async function refreshAdminData(options) {
    const opts = options || {};
    const state = {
      section: adminSection,
      loadedAt: adminDataLoadedAt,
      now: Date.now(),
      refreshing: adminRefreshing,
    };

    let decision = adminRefreshDecision(state, { force: opts.force });
    if (decision.ask) {
      const agreed = window.confirm(
        "Reloading the panel discards the changes you have not saved here. Refresh anyway?"
      );
      if (!agreed) return false;
      decision = adminRefreshDecision(state, { force: opts.force, agreed: true });
    }
    if (!decision.refresh) return false;

    adminRefreshing = true;
    try {
      await loadAdminState();
      adminDataLoadedAt = Date.now();
      if (decision.rerender) renderAdmin(false);
      if (opts.force) adminToast("The admin data was refreshed.");
      return true;
    } catch (error) {
      adminToast(apiErrorMessage(error));
      return false;
    } finally {
      adminRefreshing = false;
    }
  }

  
  // offered. OTP-backed methods are absent because no OTP attendance flow
  // exists, and "student only" is absent because a student cannot record
  // attendance. Offering them would let an administrator select a policy that
  // silently does nothing.
  const ATTENDANCE_METHODS = {
    "teacher-and-student": "Teacher and student confirmation",
    "teacher-only": "Teacher confirmation only",
  };
  // Server support for each method offered by the settings API.
  const METHOD_SUPPORT = {
    "teacher-only": "implemented",
    "teacher-and-student": "implemented",
    "otp-only": "needs-backend",
    "otp-teacher": "needs-backend",
    "otp-student": "needs-backend",
    "otp-teacher-student": "needs-backend",
  };

  function auditAdmin(entity, field, oldValue, newValue, note) {
    adminAudit.push({
      id: "ad-" + String(adminAudit.length + 1).padStart(4, "0"),
      entity: entity,
      field: field,
      oldValue: oldValue === undefined ? "" : String(oldValue),
      newValue: newValue === undefined ? "" : String(newValue),
      actorId: adminSession.role,
      note: note || "",
      at: new Date().toISOString(),
    });
  }

  // Effective settings = global defaults, then the teacher's overrides on top.
  // A globally disabled feature can never be switched on by an override.
  function effectiveSettings(teacherId) {
    const out = deepClone(platformSettings);
    const ov = teacherId ? teacherOverrides[teacherId] : null;
    if (!ov) return out;
    if (ov.attendance) {
      Object.keys(ov.attendance).forEach(function (k) {
        if (k === "verificationEnabled" && !platformSettings.attendance.verificationEnabled) return;
        out.attendance[k] = ov.attendance[k];
      });
    }
    if (ov.pricing) {
      Object.keys(ov.pricing).forEach(function (k) {
        if (platformSettings.pricing[k] && !platformSettings.pricing[k].enabled) return;
        out.pricing[k] = Object.assign({}, out.pricing[k], ov.pricing[k]);
      });
    }
    if (ov.eligibility) out.eligibility = Object.assign({}, out.eligibility, ov.eligibility);
    return out;
  }

  function setOverride(teacherId, group, key, value) {
    if (!teacherOverrides[teacherId]) teacherOverrides[teacherId] = {};
    if (!teacherOverrides[teacherId][group]) teacherOverrides[teacherId][group] = {};
    teacherOverrides[teacherId][group][key] = value;
  }
  function clearOverride(teacherId, group, key) {
    const ov = teacherOverrides[teacherId];
    if (ov && ov[group]) delete ov[group][key];
  }

  /* ------------------------- admin account fallback ------------------- */
  // Account status and approval are loaded from the server. This fallback only
  // keeps the render helpers total when a row is missing a field; it is never a
  // source of authorisation.
  const adminAccountState = {}; // id -> { status, approved, note }
  function accountState(kind, id) {
    const key = kind + ":" + id;
    if (!adminAccountState[key]) adminAccountState[key] = { status: "active", approved: false, note: "" };
    return adminAccountState[key];
  }

  const ADMIN_SECTION_TITLES = {
    overview: "Overview", teachers: "Teacher Management", bookings: "Bookings", students: "Student Management",
    attendance: "Attendance Settings", holidays: "Holidays & Availability",
    notifications: "Notification Settings",
    eligibility: "Review Eligibility Settings", pricing: "Teacher Pricing Settings",
    terms: "Terms & Conditions", contact: "Contact Us & Support", branding: "App Branding",
    otp: "OTP Verification Settings",
    settings: "General Platform Settings", moderation: "Review Moderation",
    disputes: "Attendance Disputes", roles: "Admin Roles & Permissions", audit: "Audit History",
    data: "Data & Backups",
  };

  const adminView = document.getElementById("view-admin");
  const adminSidebar = document.getElementById("admin-sidebar");
  const adminMenu = document.getElementById("admin-menu");
  const adminScrim = document.getElementById("admin-scrim");
  const adminWelcome = document.getElementById("admin-welcome");
  const adminRoleChip = document.getElementById("admin-role-chip");
  const adminBrandName = document.getElementById("admin-brand-name");
  let adminNavOpen = false;

  function adminSectionFromHash() {
    const h = String(location.hash || "").toLowerCase();
    const m = h.match(/^#\/admin\/([a-z-]+)/);
    const key = m ? m[1] : "overview";
    return ADMIN_SECTION_TITLES[key] ? key : "overview";
  }
  function showAdminSection(key) {
    const hash = "#/admin" + (key === "overview" ? "" : "/" + key);
    if (location.hash !== hash) {
      try { history.pushState({ view: "admin", section: key }, "", hash); }
      catch (e) { try { location.hash = hash; } catch (e2) {} }
    }
    renderAdmin(true);
    // The audit log is written by the server as decisions are taken, so the
    // panel is re-read when it is opened instead of showing whatever was
    // cached when the admin area was first loaded.
    if (key === "audit") refreshAdminAudit();
  }
  function setAdminNav(open) {
    adminNavOpen = !!open;
    adminView.classList.toggle("is-nav-open", adminNavOpen);
    adminMenu.setAttribute("aria-expanded", String(adminNavOpen));
  }

  /* --------------------------- small helpers -------------------------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function adminField(labelText, control, hint) {
    const wrap = el("div", "field");
    const lab = el("label", "field__label", labelText);
    if (control.id) lab.setAttribute("for", control.id);
    const box = el("div", "field__control");
    box.appendChild(control);
    wrap.appendChild(lab);
    wrap.appendChild(box);
    if (hint) wrap.appendChild(el("p", "field__hint", hint));
    return wrap;
  }
  function adminToggle(id, labelText, checked, hint) {
    const wrap = el("label", "admin-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = !!checked;
    const span = el("span", "admin-toggle__text", labelText);
    wrap.appendChild(input);
    wrap.appendChild(span);
    const out = el("div", "admin-toggle-row");
    out.appendChild(wrap);
    if (hint) out.appendChild(el("p", "field__hint", hint));
    return out;
  }
  function adminSelect(id, options, value) {
    const sel = document.createElement("select");
    sel.id = id;
    options.forEach(function (o) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }
  function adminNumber(id, value, min, max) {
    const i = document.createElement("input");
    i.type = "number";
    i.id = id;
    i.min = String(min);
    i.max = String(max);
    i.value = value === null || value === undefined ? "" : String(value);
    return i;
  }
  function adminText(id, value, placeholder) {
    const i = document.createElement("input");
    i.type = "text";
    i.id = id;
    i.value = value || "";
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  function adminTextarea(id, value, placeholder, rows) {
    const t = document.createElement("textarea");
    t.id = id;
    t.rows = rows || 4;
    t.value = value || "";
    if (placeholder) t.placeholder = placeholder;
    return t;
  }
  function adminActions(saveLabel, saveAttr) {
    const wrap = el("div", "form__actions");
    const save = el("button", "btn btn--primary");
    save.type = "button";
    save.setAttribute(saveAttr, "1");
    save.innerHTML = '<span class="btn__label">' + saveLabel + "</span>";
    const cancel = el("button", "btn btn--ghost");
    cancel.type = "button";
    cancel.setAttribute("data-admin-cancel", "1");
    cancel.innerHTML = '<span class="btn__label">Cancel</span>';
    wrap.appendChild(save);
    wrap.appendChild(cancel);
    return wrap;
  }
  function adminEmpty(title, text) {
    const box = el("div", "ft-empty");
    box.appendChild(el("p", "empty-state__title", title));
    box.appendChild(el("p", "empty-state__text", text));
    return box;
  }
  function mountFor(key) { return document.getElementById("admin-mount-" + key); }

  /* ======================== TEACHER PRICING (Part 4) ================== */
  // Prices are per teacher. An empty field is null, never 0 — a missing price
  // is simply not shown, it is never invented.
  const teacherPrices = {};   // teacherId -> { hourly, monthly, course }
  function pricesFor(teacherId) {
    if (!teacherPrices[teacherId]) {
      const globalPrices = typeof window !== "undefined" && window.teacherPrices ? (window.teacherPrices[teacherId] || window.teacherPrices["session-teacher"]) : null;
      if (globalPrices) {
        teacherPrices[teacherId] = Object.assign({ hourly: null, monthly: null, course: null }, globalPrices);
      } else {
        teacherPrices[teacherId] = { hourly: null, monthly: null, course: null };
      }
    }
    return teacherPrices[teacherId];
  }
  function formatRupees(v) {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return "";
    return "\u20b9" + n.toLocaleString("en-IN");
  }
  function pricingLabel(key) {
    return key === "hourly" ? "Per hour" : key === "monthly" ? "Monthly fee" : "Full course";
  }
  // Only the pricing types actually configured AND filled in are returned.
  function visiblePrices(teacherId) {
    const eff = effectiveSettings(teacherId);
    const p = teacherPrices[teacherId] || {};
    const out = [];
    ["hourly", "monthly", "course"].forEach(function (k) {
      if (!eff.pricing[k].enabled) return;
      const txt = formatRupees(p[k]);
      if (txt) out.push({ key: k, label: pricingLabel(k), text: txt });
    });
    return out;
  }
  function renderPricingForm() {
    const mount = document.getElementById("teacher-pricing-mount");
    if (!mount) return;
    mount.innerHTML = "";
    const teacher = collectSessionTeacher();
    if (!teacher) {
      mount.appendChild(adminEmpty("No teacher profile", "Complete your profile before adding prices."));
      return;
    }
    const eff = effectiveSettings(teacher.id);
    const prices = pricesFor(teacher.id);
    const anyEnabled = ["hourly", "monthly", "course"].some(function (k) { return eff.pricing[k].enabled; });
    if (!anyEnabled) {
      mount.appendChild(adminEmpty("Pricing is switched off",
        "An administrator has disabled every pricing type platform-wide, so no prices can be set."));
      return;
    }
    const grid = el("div", "admin-grid");
    ["hourly", "monthly", "course"].forEach(function (k) {
      const cfg = eff.pricing[k];
      if (!cfg.enabled) {
        const box = el("div", "admin-price-box");
        box.appendChild(el("h3", "tp-section__title", pricingLabel(k)));
        box.appendChild(el("p", "field__hint",
          "Unavailable — an administrator has disabled this pricing type platform-wide."));
        grid.appendChild(box);
        return;
      }
      const input = adminText("price-" + k, prices[k] === null ? "" : String(prices[k]), "e.g. 1200");
      input.inputMode = "numeric";
      const box = el("div", "admin-price-box");
      box.appendChild(el("h3", "tp-section__title", pricingLabel(k)));
      box.appendChild(adminField(
        "Amount in rupees " + (cfg.mode === "required" ? "(required)" : "(optional)"),
        input,
        cfg.mode === "required"
          ? "This pricing type is mandatory, so a value is required."
          : "Leave blank to hide this price from students."
      ));
      const err = el("p", "field__error");
      err.id = "price-" + k + "-error";
      err.hidden = true;
      box.appendChild(err);
      grid.appendChild(box);
    });
    mount.appendChild(grid);
    const actions = el("div", "form__actions");
    const save = el("button", "btn btn--primary");
    save.type = "button";
    save.setAttribute("data-save-prices", "1");
    save.innerHTML = '<span class="btn__label">Save prices</span>';
    actions.appendChild(save);
    mount.appendChild(actions);
    mount.appendChild(el("p", "field__hint",
      "Prices are shown to students as information only. Payments are not available yet."));
  }
  function savePrices() {
    const teacher = collectSessionTeacher();
    if (!teacher) return;
    const eff = effectiveSettings(teacher.id);
    const prices = pricesFor(teacher.id);
    const next = {};
    let bad = false;
    ["hourly", "monthly", "course"].forEach(function (k) {
      const err = document.getElementById("price-" + k + "-error");
      if (err) { err.hidden = true; err.textContent = ""; }
      if (!eff.pricing[k].enabled) { next[k] = prices[k]; return; }
      const raw = readVal("price-" + k).trim();
      if (!raw) {
        if (eff.pricing[k].mode === "required") {
          if (err) { err.textContent = "This pricing type is required."; err.hidden = false; }
          bad = true;
        }
        next[k] = null;   // blank stays blank — never becomes 0
        return;
      }
      const n = Number(raw);
      if (!isFinite(n) || n <= 0 || Math.floor(n) !== n) {
        if (err) { err.textContent = "Enter a whole number of rupees greater than 0."; err.hidden = false; }
        bad = true;
        return;
      }
      next[k] = n;
    });
    if (bad) { showToast("Some prices need fixing before saving."); return; }
    ["hourly", "monthly", "course"].forEach(function (k) {
      if (prices[k] !== next[k]) auditAdmin("Teacher pricing", k, prices[k], next[k]);
    });

    // FIX (D3, corrected) — integration. The original code wrote
    // teacherPrices locally and toasted "Prices saved." without calling the API.
    // The first correction called persistTeacherSection(), which PATCHes
    // /teacher/profile — but that endpoint accepts `prices` in its validation
    // whitelist and then never processes it, so the save was silently discarded
    // and the UI still claimed success. Prices are owned by PUT /teacher/prices,
    // which is what this now calls.
    apiRequest("/teacher/prices", { method: "PUT", body: { prices: next } })
      .then(function () {
        teacherPrices[teacher.id] = next;
        if (sessionProfile && sessionProfile.id) teacherPrices[sessionProfile.id] = next;
        renderPricingForm();
        renderFindTeachers();
        refreshBookingViews();
        showToast("Prices saved.");
      })
      .catch(function (error) {
        const fieldErrors = apiFieldErrors(error);
        const first = Object.keys(fieldErrors)[0];
        showToast(first ? String(fieldErrors[first][0]) : apiErrorMessage(error));
      });
  }

  /* ============================ OVERVIEW ============================== */
  function formatDataSize(bytes) {
    var n = Number(bytes) || 0;
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)) + " " + units[i];
  }

  function formatDataDate(value) {
    if (!value) return "—";
    var date = new Date(value);
    return isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function dataFact(label, value) {
    var box = el("div", "data-fact");
    box.appendChild(el("span", "data-fact__label", label));
    box.appendChild(el("span", "data-fact__value",
      value === null || value === undefined || value === "" ? "—" : String(value)));
    return box;
  }

  function dataPagerButton(label, page, disabled) {
    var button = el("button", "btn btn--ghost", label);
    button.type = "button";
    button.setAttribute("data-admin-data-page", String(page));
    button.disabled = !!disabled;
    return button;
  }

  function renderAdminDataRows(result) {
    var mount = document.querySelector("[data-admin-data-rows]");
    if (!mount) return;
    mount.innerHTML = "";

    var meta = result.meta || {};
    var page = Number(meta.page || 1);
    var lastPage = Number(meta.last_page || 1);

    mount.appendChild(el("p", "field__hint",
      "Table " + result.table + " · page " + page + " of " + lastPage
      + " · " + Number(meta.total || 0) + " row(s)."));

    var wrap = el("div", "data-table-wrap");
    var table = document.createElement("table");
    table.className = "data-table";

    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    (result.columns || []).forEach(function (column) {
      var th = document.createElement("th");
      th.textContent = column.name;
      if (column.sensitive) {
        th.className = "data-table__sensitive";
        th.title = "Masked in this read-only view";
      }
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    if (!(result.rows || []).length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = Math.max(1, (result.columns || []).length);
      emptyCell.className = "data-table__empty";
      emptyCell.textContent = "No rows match this view.";
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
    } else {
      result.rows.forEach(function (row) {
        var rowNode = document.createElement("tr");
        (result.columns || []).forEach(function (column) {
          var cell = document.createElement("td");
          var value = row[column.name];
          cell.textContent = value === null || value === undefined ? "—" : String(value);
          if (column.sensitive) cell.className = "data-table__sensitive";
          rowNode.appendChild(cell);
        });
        tbody.appendChild(rowNode);
      });
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    mount.appendChild(wrap);

    var pager = el("div", "data-pager");
    pager.appendChild(dataPagerButton("Previous", page - 1, page <= 1));
    pager.appendChild(el("span", "field__hint", "Page " + page + " of " + lastPage));
    pager.appendChild(dataPagerButton("Next", page + 1, page >= lastPage));
    mount.appendChild(pager);
  }

  function loadAdminDataRows(table, page) {
    if (!table) {
      adminToast("Choose a table first.");
      return;
    }

    adminDataTable = table;
    adminDataSearch = readVal("admin-data-search").trim();

    var mount = document.querySelector("[data-admin-data-rows]");
    if (mount) mount.textContent = "Loading…";

    apiRequest("/admin/data/tables/" + encodeURIComponent(table)
      + "?page=" + encodeURIComponent(page)
      + "&per_page=25&q=" + encodeURIComponent(adminDataSearch))
      .then(function (payload) {
        adminDataResult = payload.data;
        renderAdminDataRows(adminDataResult);
      })
      .catch(function (error) {
        if (mount) mount.textContent = "";
        adminToast(apiErrorMessage(error));
      });
  }

  function loadAdminDataFolders(root, path) {
    adminDataFolderOpen = true;
    var mount = document.querySelector("[data-admin-folder-browser]");
    if (mount) {
      mount.hidden = false;
      mount.textContent = "Loading folders…";
    }

    return apiRequest("/admin/data/folders?root=" + encodeURIComponent(root || "internal")
      + "&path=" + encodeURIComponent(path || ""))
      .then(function (payload) {
        adminDataFolderBrowse = payload.data;
        renderAdminFolderBrowser();
      })
      .catch(function (error) {
        adminDataFolderBrowse = null;
        if (mount) mount.textContent = "";
        renderAdminFolderBrowser();
        adminToast(apiErrorMessage(error));
      });
  }

  function renderAdminFolderBrowser() {
    var mount = document.querySelector("[data-admin-folder-browser]");
    if (!mount) return;

    if (!adminDataFolderOpen) {
      mount.hidden = true;
      mount.innerHTML = "";
      return;
    }

    mount.hidden = false;
    mount.innerHTML = "";

    if (!adminDataFolderBrowse) {
      mount.appendChild(el("p", "field__hint", "Folders are not loaded."));
      return;
    }

    var data = adminDataFolderBrowse;
    var head = el("div", "data-folder-browser__head");
    head.appendChild(el("span", "field__label", "Folder on the server"));
    head.appendChild(el("strong", "data-folder-browser__path", data.absolute || data.path || ""));

    var up = el("button", "btn btn--ghost");
    up.type = "button";
    up.setAttribute("data-admin-folder-up", "1");
    up.innerHTML = '<span class="btn__label">Up</span>';
    up.disabled = !data.parent;
    head.appendChild(up);
    mount.appendChild(head);

    var list = el("div", "data-folder-list");
    if (!(data.directories || []).length) {
      list.appendChild(el("p", "field__hint", "No subfolders. Create one below."));
    } else {
      data.directories.forEach(function (folder) {
        var button = el("button", "data-folder-item");
        button.type = "button";
        button.setAttribute("data-admin-folder-open", folder.path);
        button.appendChild(el("span", "data-folder-item__icon", "▸"));
        button.appendChild(el("span", "data-folder-item__name", folder.name));
        if (!folder.writable) {
          button.appendChild(el("span", "data-folder-item__note", "read only"));
        }
        list.appendChild(button);
      });
    }
    mount.appendChild(list);

    var newRow = el("div", "data-folder-new");
    var name = document.createElement("input");
    name.type = "text";
    name.maxLength = 60;
    name.placeholder = "New folder name";
    name.setAttribute("data-admin-folder-name", "1");
    newRow.appendChild(name);
    var create = el("button", "btn btn--ghost");
    create.type = "button";
    create.setAttribute("data-admin-folder-create", "1");
    create.innerHTML = '<span class="btn__label">Create folder</span>';
    newRow.appendChild(create);
    mount.appendChild(newRow);
    mount.appendChild(el("p", "field__hint",
      "Use letters, numbers, dots, underscores or hyphens. The folder is created inside the current folder."));

    var actions = el("div", "data-folder-actions");
    var select = el("button", "btn btn--primary");
    select.type = "button";
    select.setAttribute("data-admin-folder-select", "1");
    select.innerHTML = '<span class="btn__label">Select this folder</span>';
    var cancel = el("button", "btn btn--ghost");
    cancel.type = "button";
    cancel.setAttribute("data-admin-folder-cancel", "1");
    cancel.innerHTML = '<span class="btn__label">Cancel</span>';
    actions.appendChild(select);
    actions.appendChild(cancel);
    mount.appendChild(actions);
  }

  function closeAdminFolderBrowser() {
    adminDataFolderOpen = false;
    adminDataFolderBrowse = null;
    var mount = document.querySelector("[data-admin-folder-browser]");
    if (mount) {
      mount.hidden = true;
      mount.innerHTML = "";
    }
  }

  function selectAdminBackupFolder(path) {
    if (!path) return;

    if (adminDataFolderBrowse && adminDataFolderBrowse.root) {
      adminBackupRoot = adminDataFolderBrowse.root.id;
    }

    adminBackupDirectory = path;
    var current = document.querySelector("[data-admin-folder-current]");
    if (current) {
      current.textContent = (adminDataFolderBrowse && adminDataFolderBrowse.absolute) || path;
    }
    var rootSelect = document.querySelector("[data-admin-backup-root]");
    if (rootSelect && adminBackupRoot) rootSelect.value = adminBackupRoot;
    closeAdminFolderBrowser();
    adminToast("Backup folder selected. Save backup settings to apply it.");
  }

  function adminRestoreSelection() {
    var upload = document.querySelector("[data-admin-restore-upload]");
    var file = upload && upload.files && upload.files.length ? upload.files[0] : null;

    if (file) {
      return { source: "upload", file: file, name: file.name, size: file.size, date: null };
    }

    var select = document.querySelector("[data-admin-restore-server]");
    var name = select && select.value ? select.value : "";

    if (!name) return null;

    var known = ((adminDataOverview && adminDataOverview.backups) || []).filter(function (backup) {
      return backup.name === name;
    })[0];

    return {
      source: "server",
      file: null,
      name: name,
      size: known ? known.size : 0,
      date: known ? known.created_at : null,
    };
  }

  function renderAdminRestoreSummary() {
    var mount = document.querySelector("[data-admin-restore-summary]");
    if (!mount) return;

    mount.innerHTML = "";

    var restore = (adminDataOverview && adminDataOverview.restore) || {};
    var grid = el("div", "admin-grid");
    grid.appendChild(dataFact("Target database", restore.database || ""));
    var selection = adminRestoreSelection();

    if (!selection) {
      grid.appendChild(dataFact("File", "None chosen yet"));
      mount.appendChild(grid);
      return;
    }

    grid.appendChild(dataFact("File", selection.name));
    grid.appendChild(dataFact("Size", formatDataSize(selection.size)));
    if (selection.date) grid.appendChild(dataFact("Created", formatDataDate(selection.date)));
    mount.appendChild(grid);

    var upload = document.querySelector("[data-admin-restore-upload]");
    var uploadName = document.querySelector("[data-admin-restore-upload-name]");
    if (upload && uploadName) {
      uploadName.textContent = upload.files && upload.files.length
        ? upload.files[0].name + " · " + formatDataSize(upload.files[0].size)
        : "No file chosen yet.";
    }
  }

  function openAdminRestoreDialog(selection, target) {
    return new Promise(function (resolve) {
      var overlay = el("div", "data-dialog");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "admin-restore-dialog-title");

      var panel = el("div", "data-dialog__panel");
      var title = el("h3", "data-dialog__title", "Restore this database?");
      title.setAttribute("id", "admin-restore-dialog-title");
      panel.appendChild(title);
      panel.appendChild(el("p", "data-dialog__text",
        "Everything in " + target + " will be replaced by the contents of " + selection.name + "."));
      panel.appendChild(el("p", "data-dialog__warning",
        "A safety backup of the current database is written first. If the restore fails, "
        + "the database is put back to the state it was in."));

      var label = el("label", "field__label", "Type RESTORE to confirm");
      var input = document.createElement("input");
      input.type = "text";
      input.setAttribute("id", "admin-restore-confirm");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("aria-label", "Type RESTORE to confirm");
      panel.appendChild(label);
      panel.appendChild(input);

      var actions = el("div", "data-dialog__actions");
      var confirmButton = el("button", "btn btn--primary");
      confirmButton.type = "button";
      confirmButton.disabled = true;
      confirmButton.innerHTML = '<span class="btn__label">Restore now</span>';
      var cancelButton = el("button", "btn btn--ghost");
      cancelButton.type = "button";
      cancelButton.innerHTML = '<span class="btn__label">Cancel</span>';
      actions.appendChild(confirmButton);
      actions.appendChild(cancelButton);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      input.focus();

      function close(result) {
        overlay.remove();
        document.removeEventListener("keydown", onKeyDown);
        resolve(result);
      }

      function onKeyDown(event) {
        if (event.key === "Escape") close(false);
      }

      document.addEventListener("keydown", onKeyDown);
      input.addEventListener("input", function () {
        confirmButton.disabled = input.value !== "RESTORE";
      });
      confirmButton.addEventListener("click", function () {
        if (input.value === "RESTORE") close(true);
      });
      cancelButton.addEventListener("click", function () { close(false); });
      overlay.addEventListener("click", function (event) {
        if (event.target === overlay) close(false);
      });
    });
  }

  function performAdminRestore(selection) {
    var button = document.querySelector("[data-admin-restore-start]");
    if (button) button.disabled = true;

    ensureCsrf(false)
      .then(function (token) {
        return apiRequest("/admin/data/restore/token", { method: "POST" }).then(function (payload) {
          var form = new FormData();
          form.append("confirmation", "RESTORE");
          form.append("token", payload.data.token);
          form.append("source", selection.source);

          if (selection.source === "upload") {
            form.append("dump", selection.file, selection.name);
          } else {
            form.append("file", selection.name);
          }

          return apiRequest("/admin/data/restore", { method: "POST", body: form });
        });
      })
      .then(function (payload) {
        var result = payload.data || {};
        adminToast("Restore finished: " + (result.rows || 0) + " row(s) in "
          + (result.tables || 0) + " table(s).");
        return loadAdminState().then(function () { renderAdmin(false); });
      })
      .catch(function (error) { adminToast(apiErrorMessage(error)); })
      .finally(function () { if (button) button.disabled = false; });
  }

  function startAdminRestore() {
    var selection = adminRestoreSelection();

    if (!selection) {
      adminToast("Choose a backup file first.");
      return;
    }

    var restore = (adminDataOverview && adminDataOverview.restore) || {};

    openAdminRestoreDialog(selection, restore.database || "the configured database").then(function (confirmed) {
      if (!confirmed) return;
      performAdminRestore(selection);
    });
  }

  function downloadAdminBackup() {
    var button = document.querySelector("[data-admin-backup-download]");
    if (button) button.disabled = true;

    ensureCsrf(false)
      .then(function (token) {
        return fetch(apiUrl("/admin/data/backups/download"), {
          method: "POST",
          credentials: "same-origin",
          headers: { "X-CSRF-TOKEN": token, Accept: "application/octet-stream" },
        });
      })
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            var message = "The backup could not be created.";
            try { message = JSON.parse(text).message || message; } catch (error) { /* keep the default */ }
            throw new Error(message);
          });
        }

        var disposition = response.headers.get("content-disposition") || "";
        var match = /filename="?([^";]+)"?/i.exec(disposition);
        var name = match ? match[1] : "database-backup.sql";

        return response.blob().then(function (blob) {
          var url = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = url;
          link.download = name;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
          adminToast("The backup was sent to your computer.");
          return loadAdminState().then(function () { renderAdmin(false); });
        });
      })
      .catch(function (error) { adminToast(error.message || "The backup could not be created."); })
      .finally(function () { if (button) button.disabled = false; });
  }

  /* ------------------------------------------------------------------
   * Multi-Provider Cloud Storage Management System
   * ------------------------------------------------------------------ */

  function getStorageProviderIcon(key) {
    var icons = {
      local: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#475569" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
      cloudflare_r2: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#F38020"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>',
      s3: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#FF9900"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
      gcs: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#4285F4"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-6h2v6zm4 0h-2v-4h2v4zm0-6h-2V7h2v4z"/></svg>',
      azure: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#0089D6"><path d="M13.4 2.5l-6 10.8 4.2 4.1L21 21.5l-7.6-19zm-3.8 11.2L2.5 20.2h8.6l-1.5-6.5z"/></svg>',
      digitalocean: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#0080FF"><path d="M12 2C6.5 2 2 6.5 2 12c0 4.1 2.5 7.6 6 9.1v-3.7c-2-.7-3.5-2.5-3.5-4.9 0-2.8 2.2-5 5-5s5 2.2 5 5c0 2.4-1.5 4.2-3.5 4.9v3.7c3.5-1.5 6-5 6-9.1 0-5.5-4.5-10-10-10z"/></svg>',
      backblaze: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#E2231A"><path d="M12 2C8 7 4 11 4 15a8 8 0 0 0 16 0c0-4-4-8-8-13zm0 16a3 3 0 0 1-3-3c0-1.5 1.5-3 3-4.5 1.5 1.5 3 3 3 4.5a3 3 0 0 1-3 3z"/></svg>',
      wasabi: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#00D084"><path d="M12 2c-4 4-8 10-6 15 1.5 4 6 5 9 3 4-2.5 5-8 3-12-1.5-3-3.5-5-6-6z"/></svg>',
      minio: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#C72C48"><path d="M2 18h4v-7l6 6 6-6v7h4V6h-4l-6 6-6-6H2v12z"/></svg>',
    };
    return icons[key] || '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  }

  function loadAdminStorageState(forceRerender) {
    if (!isSuperAdminSession()) return Promise.resolve();
    return Promise.allSettled([
      apiRequest("/admin/storage/dashboard"),
      apiRequest("/admin/storage/providers"),
    ]).then(function (results) {
      if (results[0].status === "fulfilled" && results[0].value && results[0].value.data) {
        adminStorageDashboard = results[0].value.data;
      }
      if (results[1].status === "fulfilled" && results[1].value && results[1].value.data) {
        adminStorageProviders = results[1].value.data;
      }
      if (forceRerender) {
        renderAdmin(false);
      }
    });
  }

  function renderAdminStorageSection() {
    var wrapper = el("div", "admin-price-box storage-section");
    wrapper.style.marginBottom = "24px";

    var head = el("div", "storage-section__header");
    head.appendChild(el("h3", "tp-section__title", "Multi-Provider Cloud Storage Management"));
    head.appendChild(el("p", "field__hint",
      "Enterprise object storage architecture for sensitive documents (Aadhaar, PAN, certificates). "
      + "Configure and connect multiple cloud providers simultaneously; select one active primary destination. "
      + "Changing providers preserves access to all previously uploaded files without migration."));
    wrapper.appendChild(head);

    var dash = adminStorageDashboard || {};
    var activeInfo = dash.active_provider || {};
    var uploadStats = dash.upload_stats || { success: 0, failure: 0, success_rate: 100 };

    // Metric Cards Grid
    var statsGrid = el("div", "storage-dashboard");

    // 1. Active Primary
    var card1 = el("div", "storage-stat-card storage-stat-card--active");
    card1.appendChild(el("div", "storage-stat-card__label", "Active Primary Storage"));
    var c1Val = el("div", "storage-stat-card__value", activeInfo.name || "Local Server Storage");
    c1Val.style.fontSize = "1.2rem";
    card1.appendChild(c1Val);
    var c1Hint = el("div", "storage-stat-card__hint");
    var c1Status = activeInfo.status || "connected";
    c1Hint.innerHTML = '<span class="storage-pill storage-pill--active">Active</span> <span class="storage-pill storage-pill--' + c1Status + '">● ' + c1Status + '</span>';
    card1.appendChild(c1Hint);
    statsGrid.appendChild(card1);

    // 2. Connection Status
    var card2 = el("div", "storage-stat-card");
    card2.appendChild(el("div", "storage-stat-card__label", "Connection Status"));
    var statusTitle = activeInfo.status === "connected" ? "Connected" : (activeInfo.status === "error" ? "Error" : "Untested");
    var c2Val = el("div", "storage-stat-card__value", statusTitle);
    c2Val.style.color = activeInfo.status === "connected" ? "#059669" : (activeInfo.status === "error" ? "#dc2626" : "#d97706");
    card2.appendChild(c2Val);
    var c2Hint = el("div", "storage-stat-card__hint", activeInfo.last_tested_at ? ("Last checked: " + new Date(activeInfo.last_tested_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : "Not tested yet");
    card2.appendChild(c2Hint);
    statsGrid.appendChild(card2);

    // 3. Configured Providers
    var providers = adminStorageProviders || [];
    var configuredCount = providers.filter(function (p) { return p.is_configured; }).length;
    var card3 = el("div", "storage-stat-card");
    card3.appendChild(el("div", "storage-stat-card__label", "Configured Providers"));
    card3.appendChild(el("div", "storage-stat-card__value", String(configuredCount) + " of " + String(providers.length || 9)));
    card3.appendChild(el("div", "storage-stat-card__hint", "Multiple providers saved simultaneously"));
    statsGrid.appendChild(card3);

    // 4. Upload Health
    var card4 = el("div", "storage-stat-card");
    card4.appendChild(el("div", "storage-stat-card__label", "Upload Reliability"));
    card4.appendChild(el("div", "storage-stat-card__value", String(uploadStats.success_rate || 100) + "%"));
    card4.appendChild(el("div", "storage-stat-card__hint", String(uploadStats.success || 0) + " successful · " + String(uploadStats.failure || 0) + " failed"));
    statsGrid.appendChild(card4);

    wrapper.appendChild(statsGrid);

    // Actions Bar
    var actionsBar = el("div", "storage-actions-bar");
    var abTitle = el("div", "storage-actions-bar__title", "Supported Cloud Storage Providers (9)");
    actionsBar.appendChild(abTitle);

    var abBtns = el("div", "storage-actions-bar__buttons");

    var openLogsBtn = el("button", "btn btn--secondary");
    openLogsBtn.type = "button";
    openLogsBtn.setAttribute("data-storage-open-logs", "1");
    openLogsBtn.innerHTML = '<span class="btn__label">Storage Activity Logs</span>';
    abBtns.appendChild(openLogsBtn);

    actionsBar.appendChild(abBtns);
    wrapper.appendChild(actionsBar);

    // Providers Grid (all 9)
    var grid = el("div", "storage-grid");

    providers.forEach(function (p) {
      var card = el("div", "storage-card" + (p.is_active ? " storage-card--active" : ""));

      var cHead = el("div", "storage-card__head");
      var iconWrap = el("div", "storage-card__icon-wrap");
      iconWrap.innerHTML = getStorageProviderIcon(p.provider_key);
      cHead.appendChild(iconWrap);

      var titles = el("div", "storage-card__titles");
      var nameRow = el("div", "storage-card__name");
      nameRow.textContent = p.name;
      titles.appendChild(nameRow);

      var metaRow = el("div", "storage-card__meta");
      metaRow.appendChild(el("span", "storage-pill storage-pill--category", p.category || "Cloud S3"));
      if (p.is_active) {
        metaRow.appendChild(el("span", "storage-pill storage-pill--active", "Active Primary"));
      }
      var statusClass = p.status ? "storage-pill--" + p.status : "storage-pill--not_configured";
      var statusText = p.status === "connected" ? "● Connected" : (p.status === "error" ? "● Error" : (p.status === "untested" ? "● Needs Test" : "Not Configured"));
      metaRow.appendChild(el("span", "storage-pill " + statusClass, statusText));
      titles.appendChild(metaRow);

      cHead.appendChild(titles);
      card.appendChild(cHead);

      var desc = el("div", "storage-card__desc", p.description || "");
      card.appendChild(desc);

      var statusRow = el("div", "storage-card__status-row");
      statusRow.appendChild(el("span", "storage-card__status-label", "Last Verified:"));
      var statusVal = el("span", "field__hint");
      if (p.last_tested_at) {
        statusVal.textContent = new Date(p.last_tested_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
      } else {
        statusVal.textContent = p.is_configured ? "Untested" : "Not configured";
      }
      statusRow.appendChild(statusVal);
      card.appendChild(statusRow);

      if (p.last_error) {
        var errBox = el("div", "data-dialog__warning");
        errBox.style.fontSize = "0.78rem";
        errBox.style.padding = "6px 8px";
        errBox.style.marginBottom = "10px";
        errBox.textContent = p.last_error;
        card.appendChild(errBox);
      }

      var actions = el("div", "storage-card__actions");

      if (p.is_active) {
        var activePill = el("button", "btn btn--ghost btn--disabled");
        activePill.disabled = true;
        activePill.innerHTML = '<span class="btn__label">✓ Active Primary</span>';
        actions.appendChild(activePill);
      } else if (p.is_configured) {
        var actBtn = el("button", "btn btn--primary");
        actBtn.type = "button";
        actBtn.setAttribute("data-storage-activate", p.provider_key);
        actBtn.innerHTML = '<span class="btn__label">Make Primary</span>';
        actions.appendChild(actBtn);
      }

      var confBtn = el("button", "btn btn--secondary");
      confBtn.type = "button";
      confBtn.setAttribute("data-storage-configure", p.provider_key);
      confBtn.innerHTML = '<span class="btn__label">' + (p.is_configured ? "Edit Config" : "Configure") + '</span>';
      actions.appendChild(confBtn);

      if (p.is_configured) {
        var testBtn = el("button", "btn btn--ghost");
        testBtn.type = "button";
        testBtn.setAttribute("data-storage-test", p.provider_key);
        testBtn.innerHTML = '<span class="btn__label">Test</span>';
        actions.appendChild(testBtn);
      }

      if (p.is_configured && p.provider_key !== "local") {
        var discBtn = el("button", "btn btn--danger-ghost");
        discBtn.type = "button";
        discBtn.setAttribute("data-storage-disconnect", p.provider_key);
        discBtn.innerHTML = '<span class="btn__label">Disconnect</span>';
        actions.appendChild(discBtn);
      }

      card.appendChild(actions);
      grid.appendChild(card);
    });

    wrapper.appendChild(grid);
    return wrapper;
  }

  function openStorageConfigModal(providerKey) {
    var provider = (adminStorageProviders || []).find(function (p) { return p.provider_key === providerKey; });
    if (!provider) return;

    var overlay = el("div", "data-dialog");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var panel = el("div", "data-dialog__panel storage-modal-wide");

    var header = el("div", "storage-card__head");
    var icon = el("div", "storage-card__icon-wrap");
    icon.innerHTML = getStorageProviderIcon(provider.provider_key);
    header.appendChild(icon);

    var titles = el("div", "storage-card__titles");
    titles.appendChild(el("h3", "data-dialog__title", "Configure " + provider.name));
    titles.appendChild(el("p", "data-dialog__text", provider.description));
    header.appendChild(titles);
    panel.appendChild(header);

    var form = el("form", "storage-config-form");
    form.onsubmit = function (e) { e.preventDefault(); };

    var fields = provider.fields || [];
    var settings = provider.settings || {};
    var credentials = provider.credentials || {};

    fields.forEach(function (f) {
      var group = el("div", "storage-field-group");
      var label = el("label", "", f.label + (f.required ? " *" : ""));
      group.appendChild(label);

      var input;
      if (f.type === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.name = f.name;
        input.checked = !!(settings[f.name] !== undefined ? settings[f.name] : f.default);
        group.appendChild(input);
      } else {
        var wrap = el("div", "storage-input-wrap");
        wrap.style.position = "relative";
        input = document.createElement("input");
        input.name = f.name;

        if (f.secret) {
          input.type = "password";
          var hasSecret = credentials["has_" + f.name];
          if (hasSecret) {
            input.placeholder = "•••••••• (Saved securely. Leave blank to keep current)";
          } else {
            input.placeholder = "Enter " + f.label;
          }
        } else {
          input.type = "text";
          var curVal = settings[f.name] !== undefined ? settings[f.name] : (credentials[f.name] !== undefined ? credentials[f.name] : (f.default || ""));
          input.value = curVal;
          input.placeholder = f.default ? "Default: " + f.default : "Enter " + f.label;
        }

        wrap.appendChild(input);

        if (f.secret) {
          var toggleBtn = el("button", "btn btn--ghost");
          toggleBtn.type = "button";
          toggleBtn.style.position = "absolute";
          toggleBtn.style.right = "8px";
          toggleBtn.style.top = "50%";
          toggleBtn.style.transform = "translateY(-50%)";
          toggleBtn.style.padding = "4px 8px";
          toggleBtn.style.fontSize = "0.75rem";
          toggleBtn.textContent = "Show";
          toggleBtn.onclick = function () {
            if (input.type === "password") {
              input.type = "text";
              toggleBtn.textContent = "Hide";
            } else {
              input.type = "password";
              toggleBtn.textContent = "Show";
            }
          };
          wrap.appendChild(toggleBtn);
        }

        group.appendChild(wrap);
      }

      if (f.hint) {
        group.appendChild(el("p", "field__hint", f.hint));
      }

      form.appendChild(group);
    });

    panel.appendChild(form);

    var actions = el("div", "data-dialog__actions");
    actions.style.justifyContent = "flex-end";

    var cancelBtn = el("button", "btn btn--ghost");
    cancelBtn.type = "button";
    cancelBtn.innerHTML = '<span class="btn__label">Cancel</span>';
    cancelBtn.onclick = function () { document.body.removeChild(overlay); };
    actions.appendChild(cancelBtn);

    var saveBtn = el("button", "btn btn--primary");
    saveBtn.type = "button";
    saveBtn.innerHTML = '<span class="btn__label">Save Configuration</span>';
    saveBtn.onclick = function () {
      var configData = {};
      fields.forEach(function (f) {
        var elField = form.querySelector('[name="' + f.name + '"]');
        if (!elField) return;
        if (f.type === "boolean") {
          configData[f.name] = elField.checked;
        } else {
          configData[f.name] = elField.value.trim();
        }
      });

      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="btn__label">Saving...</span>';

      apiRequest("/admin/storage/providers/" + encodeURIComponent(providerKey), {
        method: "PUT",
        body: { config: configData },
      })
        .then(function (res) {
          adminToast(res.message || "Configuration saved.");
          document.body.removeChild(overlay);
          return loadAdminStorageState(true);
        })
        .catch(function (err) {
          adminToast(apiErrorMessage(err));
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<span class="btn__label">Save Configuration</span>';
        });
    };
    actions.appendChild(saveBtn);

    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function openStorageDocumentsModal(focusUpload) {
    var overlay = el("div", "data-dialog");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var panel = el("div", "data-dialog__panel storage-modal-wide");
    panel.style.maxWidth = "800px";

    var title = el("h3", "data-dialog__title", "Sensitive Documents Management");
    panel.appendChild(title);
    panel.appendChild(el("p", "data-dialog__text",
      "Manage stored identity cards (Aadhaar, PAN) and teacher educational certificates. Documents are stored in your active cloud/local provider."));

    // Upload box
    var uploadBox = el("div", "storage-actions-bar");
    uploadBox.style.flexDirection = "column";
    uploadBox.style.alignItems = "stretch";
    uploadBox.style.gap = "12px";

    var upHead = el("div", "storage-actions-bar__title", "Upload New Document to Active Provider (" + ((adminStorageDashboard && adminStorageDashboard.active_provider) ? adminStorageDashboard.active_provider.name : "Active Storage") + ")");
    uploadBox.appendChild(upHead);

    var upRow = el("div", "data-folder-row");
    upRow.style.gap = "10px";

    var collSelect = document.createElement("select");
    collSelect.className = "field__control";
    collSelect.style.padding = "8px 12px";
    collSelect.style.border = "1.5px solid var(--line)";
    collSelect.style.borderRadius = "var(--radius)";
    collSelect.innerHTML = '<option value="aadhaar">Aadhaar Card</option>'
      + '<option value="pan">PAN Card</option>'
      + '<option value="certificates">Educational Certificate</option>'
      + '<option value="identity">Identity Verification</option>'
      + '<option value="general">General Document</option>';
    upRow.appendChild(collSelect);

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".pdf,.jpg,.jpeg,.png,.webp";
    fileInput.style.flex = "1";
    upRow.appendChild(fileInput);

    var uploadSubmitBtn = el("button", "btn btn--primary");
    uploadSubmitBtn.type = "button";
    uploadSubmitBtn.innerHTML = '<span class="btn__label">Upload Document</span>';
    uploadSubmitBtn.onclick = function () {
      if (!fileInput.files || !fileInput.files[0]) {
        adminToast("Select a file to upload.");
        return;
      }
      var file = fileInput.files[0];
      var collection = collSelect.value;
      var form = new FormData();
      form.append("file", file);
      form.append("collection", collection);

      uploadSubmitBtn.disabled = true;
      uploadSubmitBtn.innerHTML = '<span class="btn__label">Uploading...</span>';

      ensureCsrf(false)
        .then(function (token) {
          return fetch(apiUrl("/admin/storage/documents"), {
            method: "POST",
            credentials: "same-origin",
            headers: { "X-CSRF-TOKEN": token, Accept: "application/json" },
            body: form,
          });
        })
        .then(function (resp) {
          return resp.json().then(function (json) {
            if (!resp.ok) throw new Error(json.message || "Upload failed.");
            return json;
          });
        })
        .then(function () {
          adminToast("Document uploaded successfully.");
          document.body.removeChild(overlay);
          loadAdminStorageState(true);
        })
        .catch(function (err) {
          adminToast(err.message || "Upload failed.");
          uploadSubmitBtn.disabled = false;
          uploadSubmitBtn.innerHTML = '<span class="btn__label">Upload Document</span>';
        });
    };
    upRow.appendChild(uploadSubmitBtn);
    uploadBox.appendChild(upRow);
    panel.appendChild(uploadBox);

    // Document Table Container
    var tableWrap = el("div", "storage-table-wrap");
    tableWrap.innerHTML = '<p style="padding:16px;text-align:center;color:var(--ink-400);">Loading documents...</p>';
    panel.appendChild(tableWrap);

    // Fetch documents
    apiRequest("/admin/storage/documents?per_page=50")
      .then(function (res) {
        var docs = (res && res.data) ? res.data : [];
        if (!docs.length) {
          tableWrap.innerHTML = '<p style="padding:24px;text-align:center;color:var(--ink-400);">No sensitive documents stored yet.</p>';
          return;
        }

        tableWrap.innerHTML = "";
        var table = el("table", "storage-table");
        table.innerHTML = '<thead><tr>'
          + '<th>File Name</th>'
          + '<th>Collection</th>'
          + '<th>Storage Provider</th>'
          + '<th>Size</th>'
          + '<th>Uploaded At</th>'
          + '<th>Actions</th>'
          + '</tr></thead><tbody></tbody>';
        var tbody = table.querySelector("tbody");

        docs.forEach(function (d) {
          var tr = document.createElement("tr");

          var tdName = el("td", "", d.original_name);
          tdName.style.fontWeight = "600";
          tr.appendChild(tdName);

          var tdColl = el("td");
          tdColl.innerHTML = '<span class="storage-pill storage-pill--category">' + d.collection + '</span>';
          tr.appendChild(tdColl);

          var tdProv = el("td");
          tdProv.innerHTML = '<span class="storage-pill storage-pill--active">' + d.provider_key + '</span>';
          tr.appendChild(tdProv);

          var tdSize = el("td", "", formatDataSize(d.file_size));
          tr.appendChild(tdSize);

          var tdDate = el("td", "", new Date(d.created_at).toLocaleDateString([], { dateStyle: 'short' }));
          tr.appendChild(tdDate);

          var tdActions = el("td");
          tdActions.style.whiteSpace = "nowrap";

          var dlBtn = el("button", "btn btn--ghost");
          dlBtn.type = "button";
          dlBtn.style.padding = "4px 8px";
          dlBtn.style.fontSize = "0.78rem";
          dlBtn.innerHTML = '<span class="btn__label">Download</span>';
          dlBtn.onclick = function () {
            apiRequest("/admin/storage/documents/" + encodeURIComponent(d.id) + "/signed-url")
              .then(function (urlRes) {
                if (urlRes && urlRes.data && urlRes.data.url) {
                  window.location.href = urlRes.data.url;
                } else {
                  window.location.href = apiUrl("/admin/storage/documents/" + encodeURIComponent(d.id) + "/download");
                }
              })
              .catch(function () {
                window.location.href = apiUrl("/admin/storage/documents/" + encodeURIComponent(d.id) + "/download");
              });
          };
          tdActions.appendChild(dlBtn);

          var delBtn = el("button", "btn btn--danger-ghost");
          delBtn.type = "button";
          delBtn.style.padding = "4px 8px";
          delBtn.style.fontSize = "0.78rem";
          delBtn.style.marginLeft = "4px";
          delBtn.innerHTML = '<span class="btn__label">Delete</span>';
          delBtn.onclick = function () {
            if (!window.confirm("Permanently delete document " + d.original_name + "?")) return;
            delBtn.disabled = true;
            apiRequest("/admin/storage/documents/" + encodeURIComponent(d.id), { method: "DELETE" })
              .then(function () {
                adminToast("Document deleted.");
                tr.remove();
                loadAdminStorageState(true);
              })
              .catch(function (e) { adminToast(apiErrorMessage(e)); delBtn.disabled = false; });
          };
          tdActions.appendChild(delBtn);

          tr.appendChild(tdActions);
          tbody.appendChild(tr);
        });

        tableWrap.appendChild(table);
      })
      .catch(function (err) {
        tableWrap.innerHTML = '<p style="padding:16px;color:#dc2626;">Failed to load documents: ' + apiErrorMessage(err) + '</p>';
      });

    var actions = el("div", "data-dialog__actions");
    actions.style.justifyContent = "flex-end";
    var closeBtn = el("button", "btn btn--secondary");
    closeBtn.type = "button";
    closeBtn.innerHTML = '<span class="btn__label">Close</span>';
    closeBtn.onclick = function () { document.body.removeChild(overlay); };
    actions.appendChild(closeBtn);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function openStorageLogsModal() {
    var overlay = el("div", "data-dialog");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var panel = el("div", "data-dialog__panel storage-modal-wide");
    panel.style.maxWidth = "800px";

    var title = el("h3", "data-dialog__title", "Storage Activity & Audit Trail");
    panel.appendChild(title);
    panel.appendChild(el("p", "data-dialog__text", "Historical log of upload, download, connection testing, and provider switching events."));

    var tableWrap = el("div", "storage-table-wrap");
    tableWrap.innerHTML = '<p style="padding:16px;text-align:center;color:var(--ink-400);">Loading storage activity...</p>';
    panel.appendChild(tableWrap);

    apiRequest("/admin/storage/logs?per_page=30")
      .then(function (res) {
        var logs = (res && res.data) ? res.data : [];
        if (!logs.length) {
          tableWrap.innerHTML = '<p style="padding:24px;text-align:center;color:var(--ink-400);">No storage activity logs found.</p>';
          return;
        }

        tableWrap.innerHTML = "";
        var table = el("table", "storage-table");
        table.innerHTML = '<thead><tr>'
          + '<th>Timestamp</th>'
          + '<th>Provider</th>'
          + '<th>Action</th>'
          + '<th>Status</th>'
          + '<th>Details</th>'
          + '</tr></thead><tbody></tbody>';
        var tbody = table.querySelector("tbody");

        logs.forEach(function (l) {
          var tr = document.createElement("tr");

          var tdTime = el("td", "", new Date(l.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }));
          tr.appendChild(tdTime);

          var tdProv = el("td");
          tdProv.innerHTML = '<span class="storage-pill storage-pill--category">' + l.provider_key + '</span>';
          tr.appendChild(tdProv);

          var tdAction = el("td", "", l.action);
          tdAction.style.fontWeight = "600";
          tr.appendChild(tdAction);

          var tdStatus = el("td");
          var sColor = l.status === "success" ? "storage-pill--connected" : "storage-pill--error";
          tdStatus.innerHTML = '<span class="storage-pill ' + sColor + '">' + l.status + '</span>';
          tr.appendChild(tdStatus);

          var tdMsg = el("td", "", l.message || (l.file_name ? "File: " + l.file_name : "-"));
          tdMsg.style.fontSize = "0.8rem";
          tr.appendChild(tdMsg);

          tbody.appendChild(tr);
        });

        tableWrap.appendChild(table);
      })
      .catch(function (err) {
        tableWrap.innerHTML = '<p style="padding:16px;color:#dc2626;">Failed to load logs: ' + apiErrorMessage(err) + '</p>';
      });

    var actions = el("div", "data-dialog__actions");
    actions.style.justifyContent = "flex-end";
    var closeBtn = el("button", "btn btn--secondary");
    closeBtn.type = "button";
    closeBtn.innerHTML = '<span class="btn__label">Close</span>';
    closeBtn.onclick = function () { document.body.removeChild(overlay); };
    actions.appendChild(closeBtn);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function renderAdminData() {
    var m = mountFor("data");
    m.innerHTML = "";

    if (adminSession.role !== "super-admin") {
      m.appendChild(adminEmpty("Super Admin only",
        "Database contents and backups are restricted to Super Admin accounts."));
      return;
    }

    if (!adminDataOverview) {
      m.appendChild(adminEmpty("Data not loaded yet",
        "Use Refresh data to read the connection details, backup list and tables."));
      return;
    }

    var connection = adminDataOverview.connection || {};
    var settings = adminDataOverview.settings || {};
    var tables = adminDataOverview.tables || [];
    var backups = adminDataOverview.backups || [];
    var roots = adminDataOverview.roots || [];
    var restore = adminDataOverview.restore || { allowed: false, reason: null, database: connection.database };
    adminBackupRoot = settings.root || "internal";
    adminBackupDirectory = settings.directory || "";
    adminDataFolderOpen = false;
    adminDataFolderBrowse = null;

    /* Top: Multi-Provider Cloud Storage Management System */
    m.appendChild(renderAdminStorageSection());

    var connectionBox = el("div", "admin-price-box");
    connectionBox.appendChild(el("h3", "tp-section__title", "Database connection"));
    var facts = el("div", "admin-grid");
    facts.appendChild(dataFact("Driver", connection.driver));
    facts.appendChild(dataFact("Host", connection.host
      ? connection.host + (connection.port ? ":" + connection.port : "") : null));
    facts.appendChild(dataFact("Database", connection.database));
    facts.appendChild(dataFact("Server", connection.version));
    facts.appendChild(dataFact("Size", formatDataSize(connection.size_bytes)));
    facts.appendChild(dataFact("Tables", connection.table_count));
    connectionBox.appendChild(facts);
    connectionBox.appendChild(el("p", "field__hint",
      "The connection and its password stay in the server's .env file; they cannot be changed from this panel."));
    m.appendChild(connectionBox);

    /* 1. Backup settings and retention --------------------------------- */
    var backupBox = el("div", "admin-price-box");
    backupBox.appendChild(el("h3", "tp-section__title", "Backup settings and retention"));

    var locationPath = settings.destination || settings.directory || (roots[0] && roots[0].path) || "";
    var folderField = el("div", "field");
    folderField.appendChild(el("label", "field__label", "Backup storage location on the server"));
    var folderControl = el("div", "field__control");
    var folderRow = el("div", "data-folder-row");
    var folderCurrent = el("span", "data-folder-current data-folder-current--static", locationPath);
    folderCurrent.setAttribute("data-admin-folder-current", "1");
    folderRow.appendChild(folderCurrent);
    folderControl.appendChild(folderRow);
    folderField.appendChild(folderControl);
    folderField.appendChild(el("p", "field__hint",
      "All automated and manual database backups are saved to this server location."));
    backupBox.appendChild(folderField);

    backupBox.appendChild(adminField("Keep backups for (days)",
      adminNumber("admin-backup-retain", settings.retainDays, 1, 365),
      "The newest backup is always kept, even when it is older than this."));
    backupBox.appendChild(adminToggle("admin-backup-schedule",
      "Run a scheduled backup", settings.scheduleEnabled,
      "The server checks hourly and creates one backup per day at the time below."));
    backupBox.appendChild(adminField("Backup time (24-hour)",
      adminText("admin-backup-time", settings.scheduleTime, "02:00"),
      "Server time. If the server was unavailable at that minute, the next hourly check runs it."));

    var backupActions = el("div", "form__actions");
    var saveBackups = el("button", "btn btn--primary");
    saveBackups.type = "button";
    saveBackups.setAttribute("data-admin-save-backups", "1");
    saveBackups.innerHTML = '<span class="btn__label">Save backup settings</span>';
    backupActions.appendChild(saveBackups);
    backupBox.appendChild(backupActions);
    m.appendChild(backupBox);

    /* 2. Create or download a backup ----------------------------------- */
    var createBox = el("div", "admin-price-box");
    createBox.appendChild(el("h3", "tp-section__title", "Create or download a backup"));
    createBox.appendChild(el("p", "field__hint",
      "Back up now writes a copy on the server. Download backup sends the copy to this computer; "
      + "your browser then asks where to save it."));
    var createActions = el("div", "form__actions");
    var backupNow = el("button", "btn btn--primary");
    backupNow.type = "button";
    backupNow.setAttribute("data-admin-backup-now", "1");
    backupNow.innerHTML = '<span class="btn__label">Back up now on the server</span>';
    var backupDownload = el("button", "btn btn--ghost");
    backupDownload.type = "button";
    backupDownload.setAttribute("data-admin-backup-download", "1");
    backupDownload.innerHTML = '<span class="btn__label">Download backup to this computer</span>';
    createActions.appendChild(backupNow);
    createActions.appendChild(backupDownload);
    createBox.appendChild(createActions);
    m.appendChild(createBox);

    /* 3. Backup files on the server ------------------------------------ */
    var filesBox = el("div", "admin-price-box");
    filesBox.appendChild(el("h3", "tp-section__title", "Backup files on the server"));
    if (!backups.length) {
      filesBox.appendChild(el("p", "field__hint", "No backups have been created yet."));
    } else {
      backups.forEach(function (backup) {
        var row = el("div", "data-backup");
        var meta = el("div", "data-backup__meta");
        meta.appendChild(el("strong", "data-backup__name", backup.name));
        meta.appendChild(el("span", "field__hint",
          formatDataDate(backup.created_at) + " · " + formatDataSize(backup.size)));
        row.appendChild(meta);

        var actions = el("div", "data-backup__actions");
        var download = el("a", "btn btn--ghost", "Download");
        download.href = apiUrl("/admin/data/backups/" + encodeURIComponent(backup.name));
        download.setAttribute("download", "");
        var remove = el("button", "btn btn--ghost", "Delete");
        remove.type = "button";
        remove.setAttribute("data-admin-backup-delete", backup.name);
        actions.appendChild(download);
        actions.appendChild(remove);
        row.appendChild(actions);
        filesBox.appendChild(row);
      });
    }
    filesBox.appendChild(el("p", "field__hint",
      "Backups contain every table, so download them only over a trusted connection and store them securely."));
    m.appendChild(filesBox);

    var browserBox = el("div", "admin-price-box");
    browserBox.appendChild(el("h3", "tp-section__title", "Read-only table browser"));
    browserBox.appendChild(el("p", "field__hint",
      "Sensitive columns such as passwords, tokens and session payloads are masked. "
      + "Every table view is recorded in the audit log."));

    if (!adminDataTable && tables.length) adminDataTable = tables[0].name;

    var toolbar = el("div", "admin-toolbar");
    toolbar.appendChild(adminField("Table",
      adminSelect("admin-data-table", tables.map(function (table) {
        return { value: table.name, label: table.name + " (" + table.rows + " rows)" };
      }), adminDataTable)));
    toolbar.appendChild(adminField("Search",
      adminText("admin-data-search", adminDataSearch, "Search visible columns (optional)")));
    browserBox.appendChild(toolbar);

    var loadActions = el("div", "form__actions");
    var loadRows = el("button", "btn btn--primary");
    loadRows.type = "button";
    loadRows.setAttribute("data-admin-data-load", "1");
    loadRows.innerHTML = '<span class="btn__label">Load rows</span>';
    loadActions.appendChild(loadRows);
    browserBox.appendChild(loadActions);

    var rowsMount = el("div");
    rowsMount.setAttribute("data-admin-data-rows", "1");
    browserBox.appendChild(rowsMount);
    m.appendChild(browserBox);

    if (adminDataResult && adminDataResult.table === adminDataTable) {
      renderAdminDataRows(adminDataResult);
    } else {
      rowsMount.appendChild(el("p", "field__hint", "Choose a table and load rows to inspect it."));
    }
  }

  function renderAdminOverview() {
    const m = mountFor("overview");
    m.innerHTML = "";
    const teachers = adminTeacherRows();
    const students = adminStudentRows();
    // Closed accounts stay in the lists for auditability, but they are not
    // active accounts and must not inflate the overview.
    const activeTeachers = teachers.filter(function (t) { return t.status !== "closed"; });
    const activeStudents = students.filter(function (s) { return s.status !== "closed"; });
    // FIX 6 - only profiles whose approval_status is literally "pending" await
    // a decision. Rejected profiles are not pending; they used to be counted
    // here because the test was simply `!approved`.
    const pendingApprovals = activeTeachers.filter(function (t) {
      return t.approvalStatus ? t.approvalStatus === "pending" : !t.approved;
    }).length;
    const openCases = reviewCases().length;
    const pendingReviews = reviews.length;
    const stats = [
      ["Total teachers", activeTeachers.length],
      ["Total students", activeStudents.length],
      ["Pending teacher approvals", pendingApprovals],
      ["Pending attendance disputes", openCases],
      ["Reviews on record", pendingReviews],
    ];
    const grid = el("div", "bk-stats");
    stats.forEach(function (pair) {
      const card = el("div", "bk-stat");
      card.appendChild(el("p", "bk-stat__value", String(pair[1])));
      card.appendChild(el("p", "bk-stat__label", pair[0]));
      grid.appendChild(card);
    });
    m.appendChild(grid);

    // Activity Header with Title and "Clear log" button
    const activityHeader = el("div", "admin-section-header");
    activityHeader.style.display = "flex";
    activityHeader.style.alignItems = "center";
    activityHeader.style.justifyContent = "space-between";
    activityHeader.style.flexWrap = "wrap";
    activityHeader.style.gap = "12px";
    activityHeader.style.margin = "28px 0 14px 0";

    const titleWrap = el("div");
    const actTitle = el("h3", "tp-section__title", "Recent administrative activity");
    actTitle.style.margin = "0";
    titleWrap.appendChild(actTitle);
    activityHeader.appendChild(titleWrap);

    const actActions = el("div");
    actActions.style.display = "flex";
    actActions.style.gap = "8px";
    actActions.style.alignItems = "center";

    if (adminAudit.length > 0 || adminAuditTotal > 0) {
      const clearBtn = el("button", "btn btn--ghost");
      clearBtn.type = "button";
      clearBtn.setAttribute("data-admin-audit-clear-logs", "1");
      clearBtn.style.color = "var(--danger, #d92d20)";
      clearBtn.style.borderColor = "rgba(217, 45, 32, 0.4)";
      clearBtn.innerHTML = '<span class="btn__label">Clear activity log</span>';
      actActions.appendChild(clearBtn);
    }
    activityHeader.appendChild(actActions);
    m.appendChild(activityHeader);

    // Filter toolbar box
    const filterBar = el("div", "admin-filter-bar");
    filterBar.style.display = "flex";
    filterBar.style.flexWrap = "wrap";
    filterBar.style.gap = "12px";
    filterBar.style.alignItems = "flex-end";
    filterBar.style.padding = "14px";
    filterBar.style.background = "var(--bg-card, #ffffff)";
    filterBar.style.borderRadius = "var(--radius, 12px)";
    filterBar.style.border = "1px solid var(--border, #e5e7eb)";
    filterBar.style.marginBottom = "16px";

    // 1. Action filter
    const actionWrap = el("div");
    actionWrap.style.flex = "1 1 200px";
    const actionLabel = el("label", "field__label", "Filter by action");
    actionLabel.setAttribute("for", "admin-overview-audit-action");
    actionLabel.style.marginBottom = "4px";
    actionLabel.style.display = "block";
    const actionSelect = document.createElement("select");
    actionSelect.id = "admin-overview-audit-action";
    actionSelect.className = "field__control";
    actionSelect.style.width = "100%";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All actions";
    actionSelect.appendChild(allOpt);

    const actionsSet = new Set(availableAuditActions || []);
    adminAudit.forEach(function (a) { if (a.field) actionsSet.add(a.field); });
    Array.from(actionsSet).sort().forEach(function (act) {
      const opt = document.createElement("option");
      opt.value = act;
      opt.textContent = act;
      actionSelect.appendChild(opt);
    });
    actionSelect.value = adminAuditFilters.action || "";
    actionWrap.appendChild(actionLabel);
    actionWrap.appendChild(actionSelect);
    filterBar.appendChild(actionWrap);

    // 2. Administrator filter
    const actorWrap = el("div");
    actorWrap.style.flex = "1 1 180px";
    const actorLabel = el("label", "field__label", "Administrator");
    actorLabel.setAttribute("for", "admin-overview-audit-actor");
    actorLabel.style.marginBottom = "4px";
    actorLabel.style.display = "block";
    const actorSelect = document.createElement("select");
    actorSelect.id = "admin-overview-audit-actor";
    actorSelect.className = "field__control";
    actorSelect.style.width = "100%";
    const anyAdminOpt = document.createElement("option");
    anyAdminOpt.value = "";
    anyAdminOpt.textContent = "All administrators";
    actorSelect.appendChild(anyAdminOpt);
    (apiAdminUsers || []).forEach(function (u) {
      const opt = document.createElement("option");
      opt.value = String(u.id);
      opt.textContent = u.name + (u.email ? " (" + u.email + ")" : "");
      actorSelect.appendChild(opt);
    });
    actorSelect.value = adminAuditFilters.actor_id || "";
    actorWrap.appendChild(actorLabel);
    actorWrap.appendChild(actorSelect);
    filterBar.appendChild(actorWrap);

    // 3. Search input
    const searchWrap = el("div");
    searchWrap.style.flex = "2 1 220px";
    const searchLabel = el("label", "field__label", "Search logs");
    searchLabel.setAttribute("for", "admin-overview-audit-search");
    searchLabel.style.marginBottom = "4px";
    searchLabel.style.display = "block";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.id = "admin-overview-audit-search";
    searchInput.className = "field__control";
    searchInput.placeholder = "Search entity, field, details...";
    searchInput.style.width = "100%";
    searchInput.value = adminAuditFilters.search || "";
    searchWrap.appendChild(searchLabel);
    searchWrap.appendChild(searchInput);
    filterBar.appendChild(searchWrap);

    // 4. Reset filters button
    const hasActiveFilters = Boolean(adminAuditFilters.action || adminAuditFilters.actor_id || adminAuditFilters.search);
    if (hasActiveFilters) {
      const resetWrap = el("div");
      resetWrap.style.alignSelf = "flex-end";
      const resetBtn = el("button", "btn btn--ghost");
      resetBtn.type = "button";
      resetBtn.setAttribute("data-admin-audit-reset-filters", "1");
      resetBtn.innerHTML = '<span class="btn__label">Reset filters</span>';
      resetWrap.appendChild(resetBtn);
      filterBar.appendChild(resetWrap);
    }

    m.appendChild(filterBar);

    // Filter displayed logs
    let displayedLogs = adminAudit.slice().sort(function (x, y) {
      if (x.at && y.at) return new Date(y.at) - new Date(x.at);
      return (Number(y.id) || 0) - (Number(x.id) || 0);
    });

    if (adminAuditFilters.action) {
      displayedLogs = displayedLogs.filter(function (a) {
        return (a.field || "").toLowerCase().indexOf(adminAuditFilters.action.toLowerCase()) !== -1;
      });
    }
    if (adminAuditFilters.actor_id) {
      displayedLogs = displayedLogs.filter(function (a) {
        return String(a.actorRawId || "") === String(adminAuditFilters.actor_id) ||
               String(a.actorId || "") === String(adminAuditFilters.actor_id);
      });
    }
    if (adminAuditFilters.search) {
      const q = adminAuditFilters.search.toLowerCase();
      displayedLogs = displayedLogs.filter(function (a) {
        const text = (a.entity + " " + a.field + " " + a.oldValue + " " + a.newValue + " " + a.actorId + " " + a.note).toLowerCase();
        return text.indexOf(q) !== -1;
      });
    }

    if (!adminAudit.length) {
      m.appendChild(adminEmpty(
        "No administrative activity yet",
        "Settings you change in this panel are recorded here with the old and new value."
      ));
    } else if (!displayedLogs.length) {
      m.appendChild(adminEmpty(
        "No activity matches the current filters",
        "Try adjusting or resetting your filter criteria to see other logs."
      ));
    } else {
      const logSlice = displayedLogs.slice(0, 10);
      const list = el("div", "bk-list");
      logSlice.forEach(function (a) {
        const card = el("article", "bkcard");

        const headRow = el("div");
        headRow.style.display = "flex";
        headRow.style.justifyContent = "space-between";
        headRow.style.alignItems = "center";
        headRow.style.flexWrap = "wrap";
        headRow.style.gap = "8px";
        headRow.style.marginBottom = "6px";

        const entityTitle = el("h3", "bkcard__teacher", a.entity + " · " + a.field);
        entityTitle.style.margin = "0";
        headRow.appendChild(entityTitle);

        if (a.at) {
          const timeBadge = el("span", "chip chip--soft", new Date(a.at).toLocaleString());
          timeBadge.style.fontSize = "0.78rem";
          headRow.appendChild(timeBadge);
        }
        card.appendChild(headRow);

        const facts = el("div", "bkcard__facts");
        facts.style.display = "grid";
        facts.style.gridTemplateColumns = "repeat(auto-fit, minmax(180px, 1fr))";
        facts.style.gap = "8px";
        facts.style.margin = "6px 0";

        const changeDesc = formatAuditChangeSummary(a);
        const changeFact = el("div", "bkcard__fact");
        changeFact.appendChild(el("p", "bkcard__fact-label", "Change summary"));
        const changeVal = el("p", "bkcard__fact-value", changeDesc);
        changeVal.style.wordBreak = "break-word";
        changeFact.appendChild(changeVal);
        facts.appendChild(changeFact);

        const actorFact = el("div", "bkcard__fact");
        actorFact.appendChild(el("p", "bkcard__fact-label", "Administrator"));
        actorFact.appendChild(el("p", "bkcard__fact-value", String(a.actorId || "System")));
        facts.appendChild(actorFact);

        card.appendChild(facts);

        if (a.note) {
          card.appendChild(el("p", "bkcard__note", a.note));
        }

        list.appendChild(card);
      });
      m.appendChild(list);

      const footerHint = el("div");
      footerHint.style.display = "flex";
      footerHint.style.justifyContent = "space-between";
      footerHint.style.alignItems = "center";
      footerHint.style.marginTop = "12px";
      footerHint.style.flexWrap = "wrap";
      footerHint.style.gap = "8px";

      const countText = "Showing " + logSlice.length + " of " + displayedLogs.length + (displayedLogs.length !== adminAuditTotal ? " (filtered from " + adminAuditTotal + " total entries)" : " total entries") + ".";
      footerHint.appendChild(el("p", "field__hint", countText));

      const auditLink = el("button", "btn btn--ghost");
      auditLink.type = "button";
      auditLink.setAttribute("data-anav", "audit");
      auditLink.innerHTML = '<span class="btn__label">View full audit history &rarr;</span>';
      footerHint.appendChild(auditLink);

      m.appendChild(footerHint);
    }
    m.appendChild(el("p", "field__hint",
      "Counts come from the records returned by the admin API. Nothing is fabricated."));
  }

  /* ====================== TEACHER & STUDENT LISTS ===================== */
  function adminTeacherRows() {
    // FIX 5 — these rows drive the admin overview counts and the Teacher
    // Management list. They previously read only the teacher held in this
    // browser tab, so a real database of teachers showed as zero. Prefer the
    // records returned by /api/v1/admin/teachers.
    if (Array.isArray(apiAdminTeachers) && apiAdminTeachers.length > 0) {
      return apiAdminTeachers.map(function (t) {
        const st = accountState("teacher", t.id);
        const user = apiAdminUsers.filter(function (u) { return u.id === t.id; })[0] || null;
        const approvalStatus = t.approvalStatus || "";
        const approved = approvalStatus === "approved";
        // Keep the action buttons in step with the row that was rendered. The
        // old fallback claimed every teacher was approved, so the first click
        // revoked an approval that had never been granted.
        st.approved = approved;
        st.status = (user && user.status) || st.status;
        return {
          id: t.id,
          name: t.name,
          email: (user && user.email) || t.email || "",
          subjects: t.subjects,
          mode: t.mode,
          location: t.location,
          status: st.status,
          approved: approved,
          // Carried so the overview can separate "awaiting approval" from
          // "rejected". Counting every non-approved profile as pending
          // misreported rejected teachers as pending.
          approvalStatus: approvalStatus,
          documentsVerified: !!t.documentsVerified || (t.raw && !!t.raw.documents_verified),
          documentVerificationStatus: t.documentVerificationStatus || (t.raw && t.raw.document_verification_status) || "not_uploaded",
          documentVerifiedAt: t.documentVerifiedAt || (t.raw && t.raw.document_verified_at),
          documentRejectionReason: t.documentRejectionReason || (t.raw && t.raw.document_rejection_reason),
          idDocument: t.idDocument || (t.raw && t.raw.id_document),
          qualificationDocument: t.qualificationDocument || (t.raw && t.raw.qualification_document),
          note: st.note,
        };
      });
    }
    const t = collectSessionTeacher();
    if (!t) return [];
    const st = accountState("teacher", t.id);
    return [{
      id: t.id, name: t.name, email: pEmail.value.trim(),
      subjects: t.subjects, mode: t.mode, location: t.location,
      status: st.status, approved: st.approved, note: st.note,
    }];
  }
  function adminStudentRows() {
    // FIX 5 — same as adminTeacherRows(): read the students the API returned.
    if (Array.isArray(apiAdminUsers) && apiAdminUsers.length > 0) {
      const students = apiAdminUsers.filter(function (u) {
        return u.role === "student";
      });
      if (students.length > 0) {
        return students.map(function (u) {
          const st = accountState("student", u.id);
          st.status = u.status || st.status;
          return {
            id: u.id,
            name: u.name,
            email: u.email || "",
            level: u.level || "",
            status: st.status,
            note: st.note,
          };
        });
      }
    }
    const name = currentStudentName();
    if (!name && !studentState.signup.email) return [];
    const id = currentStudentId();
    const st = accountState("student", id);
    return [{
      id: id, name: name || "(no name set)", email: studentState.signup.email || studentState.profile.email || "",
      level: studentLevelLabel(studentState.profile.level, studentState.profile.levelOther),
      status: st.status, note: st.note,
    }];
  }
  function accountCard(row, kind) {
    const card = el("article", "bkcard");
    const head = el("div", "bkcard__head");
    const av = el("div", "bkcard__avatar", initialsFrom(row.name) || "?");
    const idw = el("div", "bkcard__identity");
    idw.appendChild(el("h3", "bkcard__teacher", row.name));
    idw.appendChild(el("p", "bkcard__meta", row.email || "No email on record"));
    head.appendChild(av);
    head.appendChild(idw);
    const pill = el("span", "status status--" + (row.status === "suspended" || row.status === "closed" ? "rejected" : "accepted"),
      row.status === "closed" ? "Closed" : (row.status === "suspended" ? "Suspended" : "Active"));
    head.appendChild(pill);
    card.appendChild(head);

    const facts = el("div", "bkcard__facts");
    [["Reference", row.id],
     kind === "teacher" ? ["Subjects", (row.subjects || []).join(", ") || "None listed"] : ["Class or level", row.level || "Not set"],
     kind === "teacher" ? ["Teaching mode", row.mode || "Not set"] : null,
     kind === "teacher" ? ["Approval", row.approved ? "Approved" : (row.approvalStatus === "rejected" ? "Rejected" : "Pending approval")] : null,
     kind === "teacher" ? ["Document Verification", (function () {
       const v = row.documentVerificationStatus;
       if (v === "verified") return "Verified ✓";
       if (v === "pending") return "Pending Review ⏳";
       if (v === "rejected") return "Rejected ⚠️";
       return "Not Uploaded";
     })()] : null,
     ["Location", row.location || ""]]
      .filter(Boolean).forEach(function (pair) {
        const r = el("div", "bkcard__fact");
        r.appendChild(el("p", "bkcard__fact-label", pair[0]));
        r.appendChild(el("p", "bkcard__fact-value", pair[1]));
        facts.appendChild(r);
      });
    card.appendChild(facts);

    const actions = el("div", "bkcard__actions");
    const isClosed = row.status === "closed";

    if (!isClosed) {
      const susp = el("button", "btn btn--ghost");
      susp.type = "button";
      susp.setAttribute("data-account-toggle", kind + ":" + row.id);
      susp.innerHTML = '<span class="btn__label">' +
        (row.status === "suspended" ? "Reactivate account" : "Suspend account") + "</span>";
      actions.appendChild(susp);

      const closeAccount = el("button", "btn btn--ghost");
      closeAccount.type = "button";
      closeAccount.setAttribute("data-account-close", kind + ":" + row.id);
      closeAccount.innerHTML = '<span class="btn__label">Close account</span>';
      actions.appendChild(closeAccount);
    }

    if (kind === "teacher" && !isClosed) {
      const appr = el("button", "btn btn--ghost");
      appr.type = "button";
      appr.setAttribute("data-approve-toggle", row.id);
      appr.innerHTML = '<span class="btn__label">' +
        (row.approved ? "Revoke approval" : "Approve profile") + "</span>";
      actions.appendChild(appr);

      const overrides = el("button", "btn btn--ghost");
      overrides.type = "button";
      overrides.setAttribute("data-admin-teacher-overrides", row.id);
      overrides.innerHTML = '<span class="btn__label">Settings overrides</span>';
      actions.appendChild(overrides);

      const reviewDocs = el("button", "btn btn--ghost");
      reviewDocs.type = "button";
      reviewDocs.setAttribute("data-admin-review-docs", row.id);
      reviewDocs.innerHTML = '<span class="btn__label">Review ID &amp; Documents</span>';
      actions.appendChild(reviewDocs);
    }
    card.appendChild(actions);
    card.appendChild(el("p", "bkcard__note",
      "Suspending keeps every record and can be undone. Closing anonymises the personal details " +
      "and cannot be undone; bookings, reviews, attendance and terms acceptances are retained. " +
      "The server enforces both and records each change in the audit trail."));
    return card;
  }
  function renderAdminList(key, kind) {
    const m = mountFor(key);
    m.innerHTML = "";
    const rows = kind === "teacher" ? adminTeacherRows() : adminStudentRows();
    const searchId = "admin-" + key + "-search";
    const filterId = "admin-" + key + "-filter";

    const bar = el("div", "admin-toolbar");
    const search = adminText(searchId, adminSearch[kind] || "", "Search by name or email");
    bar.appendChild(adminField("Search", search));
    const statusSel = adminSelect(filterId, [
      { value: "all", label: "All statuses" },
      { value: "active", label: "Active" },
      { value: "suspended", label: "Suspended" },
      { value: "closed", label: "Closed" },
    ], adminStatusFilter[kind] || "all");
    bar.appendChild(adminField("Status", statusSel));
    m.appendChild(bar);

    const q = (adminSearch[kind] || "").trim().toLowerCase();
    const st = adminStatusFilter[kind] || "all";
    const visible = rows.filter(function (r) {
      if (st !== "all" && r.status !== st) return false;
      if (!q) return true;
      return (r.name + " " + r.email).toLowerCase().indexOf(q) !== -1;
    });

    m.appendChild(el("p", "ft-summary", visible.length + " of " + rows.length +
      (kind === "teacher" ? " teacher" : " student") + (rows.length === 1 ? "" : "s") + " shown."));

    if (!rows.length) {
      m.appendChild(adminEmpty(
        kind === "teacher" ? "No teacher accounts yet" : "No student accounts yet",
        "Accounts appear here once someone creates an account."
      ));
      return;
    }
    if (!visible.length) {
      m.appendChild(adminEmpty("No accounts match", "Try a different search or status filter."));
      return;
    }
    const list = el("div", "bk-list");
    visible.forEach(function (r) { list.appendChild(accountCard(r, kind)); });
    m.appendChild(list);
  }

  let adminSearch = { teacher: "", student: "" };
  let adminStatusFilter = { teacher: "all", student: "all" };

  /* ====================== ATTENDANCE SETTINGS ========================= */
  function renderAdminAttendance() {
    const m = mountFor("attendance");
    m.innerHTML = "";
    const a = platformSettings.attendance;

    m.appendChild(adminToggle("admin-att-enabled", "Enable attendance verification", a.verificationEnabled,
      "When off, attendance recording is disabled platform-wide and no teacher override can re-enable it."));

    const methodOptions = Object.keys(ATTENDANCE_METHODS).map(function (k) {
      return { value: k, label: ATTENDANCE_METHODS[k] + (METHOD_SUPPORT[k] === "needs-backend" ? " (needs backend)" : "") };
    });
    m.appendChild(adminField("Verification method", adminSelect("admin-att-method", methodOptions, a.method),
      "The selected method drives the actual workflow, not just the label."));
    m.appendChild(el("p", "field__hint", "Support status: " + (METHOD_SUPPORT[a.method] === "implemented"
      ? "enforced by the server."
      : "not available on this server.")));

    // The four statements below were configuration controls that could not be
    // honoured. The requirements fix this behaviour, so they are shown as fixed
    // facts rather than choices that silently did nothing.

    // ── ADMIN SETTINGS: attendance.onMissingConfirmation ─────────────────────
    // Fixed, not configurable. A missing response stays Pending until the policy
    // resolves it. `confirmation` is an enum of pending/confirmed/disputed, so
    // "mark-unverified" has no state to occupy, and "auto-confirm" would record
    // attendance without the confirmation the rules require.
    m.appendChild(el("p", "field__hint",
      "On missing confirmation — fixed: a missing teacher or student response stays Pending until an administrator resolves it. " +
      "The confirmation states are pending, confirmed and disputed, so a \"mark as unverified\" state does not exist."));

    // ── ADMIN SETTINGS: attendance.onConflictingConfirmation ─────────────────
    // Fixed, not configurable. A conflict must become Disputed and go to admin
    // review, preserving both sides. Picking a winner automatically would discard
    // one party's evidence, which the rules forbid.
    m.appendChild(el("p", "field__hint",
      "On conflicting confirmation — fixed: conflicting responses become Disputed and require an admin decision. " +
      "The teacher's entry, the student's response, the reason and the timestamps are all preserved. " +
      "Automatically keeping one side's entry is not offered."));

    // ── ADMIN SETTINGS: attendance.disputesRequireAdminReview ────────────────
    // Redundant control, removed. Admin review is mandatory in the requirements:
    // a toggle that could switch it off would remove a safeguard, and one that can
    // only ever be on changes nothing. Recorded here so it is not mistaken for a
    // working setting.
    m.appendChild(el("p", "field__hint",
      "Disputes require admin review — always on and not configurable. " +
      "Every dispute is decided by an administrator and the decision is written to the audit trail."));

    // ── ADMIN SETTINGS: attendance.otpExpiryMinutes / otpMaxAttempts ─────────
    // Not operational. There is no attendance OTP workflow — the OTP engine serves
    // the WhatsApp integration test only, and that has its own expiry and attempt
    // limits under the WhatsApp section. Showing numbers here would imply a
    // workflow that is not implemented, so the fields were removed rather than
    // left to look functional.
    m.appendChild(el("p", "field__hint",
      "Attendance OTP — not available. Attendance is verified by teacher and/or student confirmation; " +
      "there is no OTP step for lessons. The WhatsApp integration test has its own expiry and attempt limits."));

    m.appendChild(adminToggle("admin-att-reason", "Require a reason when a lesson is reported as not held", a.requireReasonWhenLessonMissed));
    m.appendChild(adminActions("Save attendance settings", "data-admin-save-attendance"));
    m.appendChild(el("p", "field__hint", "Changing these does not rewrite any existing attendance record."));
  }

  /* ====================== OTP VERIFICATION ========================== */
  function renderAdminOtp() {
    const m = mountFor("otp");
    if (!m) return;
    m.innerHTML = "";

    const otp = platformSettings.otp || {
      enabled: true,
      requireRegistrationOtp: false,
      requirePasswordResetOtp: true,
      channel: "whatsapp",
      otpExpiryMinutes: 10,
      otpMaxAttempts: 5,
    };
    const w = platformSettings.whatsapp || {
      enabled: false,
      provider: "meta-cloud-api",
      phoneNumberId: "",
      businessAccountId: "",
      testRecipient: "",
      credentialSource: "server-environment",
      lastTestStatus: "not-configured",
    };

    m.appendChild(el("h3", "tp-section__title", "OTP Verification System"));
    m.appendChild(el("p", "field__hint",
      "Manage one-time password (OTP) verification requirements across registration and password reset. " +
      "Codes are 6 digits, cryptographically hashed with bcrypt, single-use, and rate-limited."));

    m.appendChild(adminToggle("admin-otp-enabled", "Enable OTP verification system (Master Switch)", otp.enabled,
      "When turned off, all OTP verification challenges across the platform are bypassed."));

    m.appendChild(el("h3", "tp-section__title", "Verification Triggers"));
    m.appendChild(adminToggle("admin-otp-reg", "Require OTP for Account Registration", otp.requireRegistrationOtp,
      "When enabled, student and teacher signups must verify their WhatsApp/phone number via OTP before their account is created."));
    m.appendChild(adminToggle("admin-otp-pass", "Require OTP for Password Reset", otp.requirePasswordResetOtp,
      "When enabled, users reset their account password via WhatsApp OTP instead of relying on email reset links."));

    m.appendChild(el("h3", "tp-section__title", "Code Expiry & Limits"));
    const gridOtp = el("div", "admin-grid");
    gridOtp.appendChild(adminField("Code expiry (minutes)", adminNumber("admin-otp-expiry", otp.otpExpiryMinutes || 10, 1, 60),
      "Codes expire automatically after this many minutes."));
    gridOtp.appendChild(adminField("Maximum incorrect attempts", adminNumber("admin-otp-attempts", otp.otpMaxAttempts || 5, 1, 10),
      "After this many failed attempts, the code is permanently invalidated."));
    m.appendChild(gridOtp);

    m.appendChild(el("h3", "tp-section__title", "WhatsApp Cloud API Delivery"));
    m.appendChild(el("p", "field__hint",
      "Uses Meta's official WhatsApp Business Platform (Cloud API). Access tokens are kept safe in the backend environment."));

    m.appendChild(adminToggle("admin-wa-enabled", "Enable WhatsApp Cloud API provider", w.enabled,
      "Switches and IDs are stored in the database; the access token is read from the server environment only."));

    const gridWa = el("div", "admin-grid");
    gridWa.appendChild(adminField("Phone number ID", adminText("admin-wa-phone-id", w.phoneNumberId, "from Meta app dashboard")));
    gridWa.appendChild(adminField("Business account ID", adminText("admin-wa-waba-id", w.businessAccountId, "WABA id")));
    gridWa.appendChild(adminField("Test recipient (with country code)", adminText("admin-wa-test-to", w.testRecipient, "+91...")));
    m.appendChild(gridWa);

    m.appendChild(el("p", "field__hint", "Credential source: " + (w.credentialSource || "server-environment") +
      " — the access token is read from the server environment and is never entered or stored here."));

    const status = el("div", "tp-note");
    const live = apiWhatsappStatus;
    if (live) {
      status.appendChild(el("p", "", live.configured
        ? "Provider status: Ready. Credentials are configured on this server."
        : "Provider status: Not configured. " + (live.reason || "No provider credentials are present on this server.")));
      status.appendChild(el("p", "field__hint",
        "Access token: " + (live.accessTokenSet ? "present" : "missing") +
        ". Phone number ID: " + (live.phoneNumberIdSet ? "set" : "missing") +
        ". Integration switch: " + (live.enabled ? "on" : "off") + "."));
    } else {
      status.appendChild(el("p", "", "Provider status is unavailable. In local development, generated OTP codes are testable immediately."));
    }
    status.appendChild(el("p", "field__hint", w.lastTestStatus === "sent"
      ? "Last test: provider accepted the message."
      : w.lastTestStatus === "not-delivered"
        ? "Last test: the code was generated successfully (delivery pending provider credentials)."
        : "No test message has been delivered from this screen yet."));
    m.appendChild(status);

    const testActions = el("div", "form__actions");
    const send = el("button", "btn btn--ghost");
    send.type = "button";
    send.setAttribute("data-admin-wa-send", "1");
    send.innerHTML = '<span class="btn__label">Send test OTP</span>';
    testActions.appendChild(send);
    m.appendChild(testActions);

    m.appendChild(adminActions("Save OTP & WhatsApp settings", "data-admin-save-otp"));
  }

  /* ==================== HOLIDAYS & AVAILABILITY ======================= */
  function renderAdminHolidays() {
    const m = mountFor("holidays");
    m.innerHTML = "";
    const h = platformSettings.holidays;

    const grid = el("div", "admin-grid");
    grid.appendChild(adminField("Holiday date", (function () {
      const i = document.createElement("input"); i.type = "date"; i.id = "admin-holiday-date"; return i;
    })()));
    grid.appendChild(adminField("Label", adminText("admin-holiday-label", "", "e.g. Diwali")));
    m.appendChild(grid);
    const add = el("div", "form__actions");
    const addBtn = el("button", "btn btn--primary");
    addBtn.type = "button";
    addBtn.setAttribute("data-admin-holiday-add", "1");
    addBtn.innerHTML = '<span class="btn__label">Add platform holiday</span>';
    add.appendChild(addBtn);
    m.appendChild(add);

    m.appendChild(el("h3", "tp-section__title", "Platform-wide holidays"));
    if (!h.platform.length) {
      m.appendChild(adminEmpty("No platform holidays", "Add a date above. Platform holidays are kept separate from teacher holidays."));
    } else {
      const list = el("div", "bk-list");
      h.platform.forEach(function (hol) {
        const card = el("article", "bkcard");
        card.appendChild(el("h3", "bkcard__teacher", prettyDate(hol.date)));
        card.appendChild(el("p", "bkcard__meta", hol.label || "Holiday"));
        const acts = el("div", "bkcard__actions");
        const rm = el("button", "btn btn--ghost");
        rm.type = "button";
        rm.setAttribute("data-admin-holiday-remove", hol.id || hol.date);
        rm.innerHTML = '<span class="btn__label">Remove</span>';
        acts.appendChild(rm);
        card.appendChild(acts);
        list.appendChild(card);
      });
      m.appendChild(list);
    }

    m.appendChild(adminToggle("admin-holiday-block", "Platform holidays prevent new bookings", h.blockNewBookings));
    m.appendChild(el("p", "field__hint",
      "Adding a holiday never changes a booking that already exists. Affected bookings are listed below so an administrator can act on each one explicitly."));

    // The affected bookings are always listed. The rule is fixed: a holiday
    // blocks new bookings and never touches the ones that already exist.
    const affected = adminAffectedBookings();
    m.appendChild(el("h3", "tp-section__title", "Bookings falling on a holiday"));
    if (!affected.length) {
      m.appendChild(adminEmpty("No affected bookings", "No existing booking falls on a platform holiday."));
    } else {
      const list = el("div", "bk-list");
      affected.forEach(function (b) {
        const card = el("article", "bkcard");
        card.appendChild(el("h3", "bkcard__teacher", b.teacherName + " · " + b.subject));
        card.appendChild(el("p", "bkcard__meta", prettyDate(b.date) + " at " + b.time + " · " + b.status));
        list.appendChild(card);
      });
      m.appendChild(list);
      m.appendChild(el("p", "field__hint", "These bookings are unchanged. Cancelling or rescheduling requires an explicit action."));
    }

    m.appendChild(el("h3", "tp-section__title", "Teacher-specific unavailable dates"));
    m.appendChild(el("p", "field__hint",
      "A date listed here is refused when a student tries to book this teacher. " +
      "Bookings that already exist are never changed."));
    const unavailableTeachers = adminTeacherRows();
    if (!unavailableTeachers.length) {
      m.appendChild(adminEmpty("No teachers", "A teacher has to exist before unavailable dates can be set."));
    } else {
      const picker = document.createElement("select");
      picker.id = "admin-teacher-unavailable-select";
      unavailableTeachers.forEach(function (t) {
        const option = document.createElement("option");
        option.value = String(t.id);
        option.textContent = t.name;
        picker.appendChild(option);
      });
      if (adminUnavailableTeacher) picker.value = adminUnavailableTeacher;
      m.appendChild(adminField("Teacher", picker, "Choose the teacher whose unavailable dates are managed."));

      const list = el("div", "bk-list");
      adminUnavailableList = list;
      m.appendChild(list);

      const dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.id = "admin-teacher-unavailable-date";
      m.appendChild(adminField("Unavailable date", dateInput));

      const reasonInput = document.createElement("input");
      reasonInput.type = "text";
      reasonInput.id = "admin-teacher-unavailable-reason";
      reasonInput.placeholder = "Optional reason";
      m.appendChild(adminField("Reason (optional)", reasonInput));

      const add = el("button", "btn btn--primary");
      add.type = "button";
      add.setAttribute("data-admin-add-unavailable", "1");
      add.innerHTML = '<span class="btn__label">Add unavailable date</span>';
      m.appendChild(add);

      renderAdminTeacherUnavailableDates();
    }
    m.appendChild(adminActions("Save holiday settings", "data-admin-save-holidays"));
  }

  function adminAffectedBookings() {
    const dates = platformSettings.holidays.platform.map(function (h) { return h.date; });
    return bookings.filter(function (b) { return dates.indexOf(b.date) !== -1; });
  }
  function isDateUnavailable(date, teacherId) {
    if (platformSettings.holidays.blockNewBookings &&
        platformSettings.holidays.platform.some(function (h) { return h.date === date; })) return true;
    const ov = teacherId && teacherOverrides[teacherId];
    if (ov && ov.holidays && ov.holidays.indexOf(date) !== -1) return true;
    return false;
  }

  /* ================= REVIEW ELIGIBILITY SETTINGS ====================== */
  function renderAdminEligibility() {
    const m = mountFor("eligibility");
    m.innerHTML = "";
    const e = platformSettings.eligibility;
    m.appendChild(adminToggle("admin-el-configured", "Review eligibility is configured", e.configured,
      "While this is off, eligibility cannot be determined and reviews stay locked."));
    m.appendChild(adminField("Primary policy", adminSelect("admin-el-type", [
      { value: "study-days", label: "Mutually confirmed study days" },
      { value: "completed-lessons", label: "Completed lessons" },
    ], e.type)));
    const grid = el("div", "admin-grid");
    grid.appendChild(adminField("Minimum confirmed study days", adminNumber("admin-el-days", e.minConfirmedDays, 1, 99)));
    grid.appendChild(adminField("Minimum completed lessons", adminNumber("admin-el-lessons", e.minCompletedLessons, 0, 99)));
    m.appendChild(grid);
    m.appendChild(adminToggle("admin-el-booking", "Require a completed booking", e.requireCompletedBooking));
    m.appendChild(el("p", "field__hint",
      "Only confirmed attendance counts. A pending, unconfirmed or disputed record is never " +
      "evidence that a lesson happened, and the server applies the same rule."));
    m.appendChild(el("p", "field__hint",
      "One review per completed lesson. The same student may review the same teacher again " +
      "for a different completed lesson."));
    m.appendChild(adminActions("Save eligibility settings", "data-admin-save-eligibility"));
    m.appendChild(el("p", "field__hint",
      "Changing the policy never deletes or alters an existing review. Historical decisions are kept."));
  }

  /* ======================== PRICING SETTINGS ========================== */
  function renderAdminPricing() {
    const m = mountFor("pricing");
    m.innerHTML = "";
    const p = platformSettings.pricing;
    const grid = el("div", "admin-grid");
    [["hourly", "Per-hour charges"], ["monthly", "Monthly fees"], ["course", "Full-course fees"]]
      .forEach(function (pair) {
        const box = el("div", "admin-price-box");
        box.appendChild(el("h3", "tp-section__title", pair[1]));
        const en = document.createElement("input");
        en.type = "checkbox";
        en.id = "admin-price-" + pair[0] + "-enabled";
        en.checked = p[pair[0]].enabled;
        const enLab = el("label", "admin-toggle");
        enLab.appendChild(en);
        enLab.appendChild(el("span", "admin-toggle__text", "Enabled platform-wide"));
        box.appendChild(enLab);
        box.appendChild(adminField("Requirement", adminSelect("admin-price-" + pair[0] + "-mode", [
          { value: "optional", label: "Optional for teachers" },
          { value: "required", label: "Required for applicable teachers" },
        ], p[pair[0]].mode)));
        grid.appendChild(box);
      });
    m.appendChild(grid);
    m.appendChild(adminActions("Save pricing settings", "data-admin-save-pricing"));

    m.appendChild(el("h3", "tp-section__title", "Effective configuration per teacher"));
    const teachers = adminTeacherRows();
    if (!teachers.length) {
      m.appendChild(adminEmpty("No teachers", "Per-teacher pricing appears once a teacher profile exists."));
      return;
    }
    const list = el("div", "bk-list");
    teachers.forEach(function (t) {
      const eff = effectiveSettings(t.id);
      const card = el("article", "bkcard");
      card.appendChild(el("h3", "bkcard__teacher", t.name));
      const facts = el("div", "bkcard__facts");
      ["hourly", "monthly", "course"].forEach(function (k) {
        const r = el("div", "bkcard__fact");
        r.appendChild(el("p", "bkcard__fact-label", k));
        r.appendChild(el("p", "bkcard__fact-value",
          eff.pricing[k].enabled ? ("enabled · " + eff.pricing[k].mode) : "disabled by global policy"));
        facts.appendChild(r);
      });
      card.appendChild(facts);
      list.appendChild(card);
    });
    m.appendChild(list);
    m.appendChild(el("p", "field__hint",
      "A pricing type disabled globally can never be switched on for one teacher."));
  }

  /* ============================ TERMS ================================= */
  function roleTermsDefaultTitle(role) {
    if (role === "common") return "Common policies";
    if (role === "privacy") return "Privacy Policy";
    if (role === "student") return "Student terms";
    if (role === "teacher") return "Teacher terms";
    if (role === "refund") return "Refund & Cancellation Policy";
    return role.split(/[_-]/).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ") + " terms";
  }

  function termsDocFor(role) {
    return (platformSettings.terms && platformSettings.terms[role]) || null;
  }
  async function publishTerms(role, title, body) {
    const existing = platformSettings.terms[role];
    const response = await apiRequest("/admin/terms", {
      method: "POST",
      body: { audience: role, title: title, body: body },
    });
    auditAdmin("Terms (" + role + ")", "version", existing ? existing.version : 0,
      response && response.data ? response.data.version : "new", "Published");
    await loadAdminState();
    return response && response.data ? response.data : null;
  }
  function renderAdminTerms() {
    const m = mountFor("terms");
    m.innerHTML = "";

    const header = el("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.flexWrap = "wrap";
    header.style.gap = "12px";
    header.style.marginBottom = "16px";

    const hintWrap = el("div");
    hintWrap.appendChild(el("p", "field__hint",
      "Plain-text editor — no HTML required. Draft, preview, publish, or delete terms and policies as needed. Saving empty is supported."));
    header.appendChild(hintWrap);

    const addBtn = el("button", "btn btn--primary");
    addBtn.type = "button";
    addBtn.setAttribute("data-admin-terms-add", "1");
    addBtn.innerHTML = '<span class="btn__label">+ Add new policy / terms</span>';
    header.appendChild(addBtn);
    m.appendChild(header);

    const standardRoles = ["common", "privacy", "student", "teacher"];
    const allRoles = Array.from(new Set(standardRoles.concat(customTermsPolicies)));

    allRoles.forEach(function (role) {
      const pub = termsDocFor(role);
      const draft = platformSettings.terms["draft-" + role];
      const box = el("div", "admin-price-box");
      box.style.marginBottom = "24px";

      const topRow = el("div");
      topRow.style.display = "flex";
      topRow.style.justifyContent = "space-between";
      topRow.style.alignItems = "center";
      topRow.style.flexWrap = "wrap";
      topRow.style.gap = "8px";

      const secTitle = el("h3", "tp-section__title", roleTermsDefaultTitle(role));
      secTitle.style.margin = "0";
      topRow.appendChild(secTitle);

      if (!standardRoles.includes(role)) {
        const removeCustomBtn = el("button", "btn btn--ghost");
        removeCustomBtn.type = "button";
        removeCustomBtn.setAttribute("data-admin-terms-remove-custom", role);
        removeCustomBtn.style.color = "var(--danger, #d92d20)";
        removeCustomBtn.style.fontSize = "0.82rem";
        removeCustomBtn.innerHTML = '<span class="btn__label">Remove section</span>';
        topRow.appendChild(removeCustomBtn);
      }
      box.appendChild(topRow);

      const pubInfo = pub && pub.version
        ? "Published version " + pub.version + " · effective " + (pub.effectiveDate || "") +
          " · published by " + (pub.publishedBy || "Administrator") + " · " + (pub.history || []).length + " previous version(s)"
        : "Nothing published yet.";
      const pubHint = el("p", "field__hint", pubInfo);
      pubHint.style.marginTop = "4px";
      box.appendChild(pubHint);

      const defaultValTitle = draft ? draft.title : (pub ? pub.title : "");
      const defaultValBody = draft ? draft.body : (pub ? pub.body : "");

      box.appendChild(adminField("Title", adminText("admin-terms-" + role + "-title", defaultValTitle,
        roleTermsDefaultTitle(role))));
      box.appendChild(adminField("Body", adminTextarea("admin-terms-" + role + "-body", defaultValBody,
        "Write the clauses here. One clause per line. Can be left empty if desired.", 6)));

      const acts = el("div", "form__actions");
      acts.style.display = "flex";
      acts.style.flexWrap = "wrap";
      acts.style.gap = "8px";
      acts.style.alignItems = "center";

      const save = el("button", "btn btn--ghost");
      save.type = "button";
      save.setAttribute("data-admin-terms-draft", role);
      save.innerHTML = '<span class="btn__label">Save draft</span>';
      acts.appendChild(save);

      const prev = el("button", "btn btn--ghost");
      prev.type = "button";
      prev.setAttribute("data-admin-terms-preview", role);
      prev.innerHTML = '<span class="btn__label">Preview draft</span>';
      acts.appendChild(prev);

      const publish = el("button", "btn btn--primary");
      publish.type = "button";
      publish.setAttribute("data-admin-terms-publish", role);
      publish.innerHTML = '<span class="btn__label">Publish new version</span>';
      acts.appendChild(publish);

      if (pub && pub.version) {
        const delTerms = el("button", "btn btn--ghost");
        delTerms.type = "button";
        delTerms.setAttribute("data-admin-terms-delete", role);
        delTerms.style.color = "var(--danger, #d92d20)";
        delTerms.style.borderColor = "rgba(217, 45, 32, 0.4)";
        delTerms.innerHTML = '<span class="btn__label">Delete published terms</span>';
        acts.appendChild(delTerms);
      }

      if (draft) {
        const clearDraft = el("button", "btn btn--ghost");
        clearDraft.type = "button";
        clearDraft.setAttribute("data-admin-terms-clear-draft", role);
        clearDraft.innerHTML = '<span class="btn__label">Clear draft</span>';
        acts.appendChild(clearDraft);
      }

      box.appendChild(acts);

      box.appendChild(el("p", "field__hint", draft ? "Unpublished draft saved. Ordinary users never see it." : "No draft in progress."));
      box.appendChild(el("div", "admin-preview", ""));
      box.lastChild.id = "admin-terms-" + role + "-preview";

      if (pub && (pub.history || []).length) {
        box.appendChild(el("h4", "tp-section__title", "Previous versions"));
        const hl = el("div", "bk-list");
        pub.history.forEach(function (h) {
          const c = el("article", "bkcard");
          c.appendChild(el("h3", "bkcard__teacher", "Version " + h.version + " · " + h.title));
          c.appendChild(el("p", "bkcard__meta", "Effective " + h.effectiveDate + " · published by " + h.publishedBy));
          hl.appendChild(c);
        });
        box.appendChild(hl);
      }
      m.appendChild(box);
    });
  }

  /* ============================ CONTACT =============================== */
  function normalizeWhatsapp(raw) {
    const digits = String(raw || "").replace(/[^\d]/g, "");
    if (!digits) return "";
    // wa.me needs a country code and no leading plus or zero.
    return digits.replace(/^0+/, "");
  }
  function validEmail(v) { return !validateEmailValue(v); }
  function validPhone(v) { return /^[+]?[\d][\d\s-]{6,}$/.test(String(v || "").trim()); }
  function renderAdminContact() {
    const m = mountFor("contact");
    m.innerHTML = "";
    const c = platformSettings.contact;
    m.appendChild(adminToggle("admin-contact-enabled", "Show the Contact Us section", c.enabled,
      "Turning this off hides the whole section for students and teachers."));
    m.appendChild(adminField("Support page title", adminText("admin-contact-title-field", c.title)));
    m.appendChild(adminField("Introductory message", adminTextarea("admin-contact-message", c.message, "How can we help?", 3)));
    const grid = el("div", "admin-grid");
    grid.appendChild(adminField("Support email", adminText("admin-contact-email", c.email, "support@example.com")));
    grid.appendChild(adminField("Support phone", adminText("admin-contact-phone", c.phone, "+91 ...")));
    grid.appendChild(adminField("WhatsApp number", adminText("admin-contact-whatsapp", c.whatsapp, "91XXXXXXXXXX")));
    grid.appendChild(adminField("Business hours (optional)", adminText("admin-contact-hours", c.hours, "Mon–Fri, 9am–6pm")));
    m.appendChild(grid);
    m.appendChild(adminToggle("admin-contact-show-email", "Show the email contact", c.showEmail));
    m.appendChild(adminToggle("admin-contact-show-phone", "Show the phone contact", c.showPhone));
    m.appendChild(adminToggle("admin-contact-show-whatsapp", "Show the WhatsApp contact", c.showWhatsapp));
    m.appendChild(el("p", "field__hint",
      "Invalid or empty details are hidden rather than shown as a broken link. No placeholder " +
      "numbers are ever presented as real contacts."));
    m.appendChild(adminActions("Save contact settings", "data-admin-save-contact"));

    const preview = el("div", "admin-preview");
    preview.id = "admin-contact-preview";
    preview.innerHTML = contactSectionHtml(c);
    m.appendChild(el("h3", "tp-section__title", "Preview"));
    m.appendChild(preview);
  }
  // Shared renderer so the admin preview and the real user-facing section agree.
  function contactSectionHtml(c) {
    if (!c.enabled) return '<p class="field__hint">The Contact Us section is hidden.</p>';
    const parts = [];
    if (c.showEmail && validEmail(c.email)) {
      parts.push('<li><a href="mailto:' + escapeAttr(c.email) + '">' + escapeHtml(c.email) + "</a></li>");
    }
    if (c.showPhone && validPhone(c.phone)) {
      parts.push('<li><a href="tel:' + escapeAttr(c.phone.replace(/\s/g, "")) + '">' + escapeHtml(c.phone) + "</a></li>");
    }
    const wa = normalizeWhatsapp(c.whatsapp);
    if (c.showWhatsapp && wa.length >= 8) {
      parts.push('<li><a href="https://wa.me/' + escapeAttr(wa) + '" rel="noopener noreferrer" target="_blank">WhatsApp ' + escapeHtml(c.whatsapp) + "</a></li>");
    }
    if (!parts.length) return '<p class="field__hint">No valid contact method is enabled.</p>';
    return "<h4>" + escapeHtml(c.title || "Contact & support") + "</h4>" +
      (c.message ? "<p>" + escapeHtml(c.message) + "</p>" : "") +
      '<ul class="contact-list">' + parts.join("") + "</ul>" +
      (c.hours ? '<p class="field__hint">' + escapeHtml(c.hours) + "</p>" : "");
  }
  function escapeHtml(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeAttr(v) { return escapeHtml(v).replace(/[^\w\s@.+\-/:%?#&=]/g, ""); }

  /* ============================ BRANDING ============================== */
  // Branding is applied from ONE place: every brand name, mark, title and
  // favicon in the application is driven from `platformSettings.branding`.
  const DEFAULT_MARK = '<svg width="20" height="20" aria-hidden="true"><use href="#i-grad" /></svg>';
  const pendingBrandFiles = {}; // slot -> File selected but not uploaded yet
  function applyBranding() {
    const b = platformSettings.branding || {};
    const name = (b.appName || "EduPlatform").trim() || "EduPlatform";
    document.querySelectorAll(".brand__name, .sidebar__name, [data-brand-name]").forEach(function (n) {
      n.textContent = name;
    });
    document.querySelectorAll('[aria-label*="EduPlatform"], [data-brand-label]').forEach(function (n) {
      const label = n.getAttribute("aria-label");
      if (label) n.setAttribute("aria-label", label.replace(/EduPlatform/g, name));
    });
    document.title = (ROUTES[currentView] && ROUTES[currentView].title)
      ? ROUTES[currentView].title.replace(/EduPlatform/g, name)
      : name + " · Education platform";
    document.querySelectorAll(".brand-mark, [data-brand-logo]").forEach(function (n) {
      // The logo URL comes from the server, so the element is built with the
      // DOM API. Concatenating a stored value into markup would let an
      // administrator persist markup that runs in every visitor's browser.
      n.innerHTML = "";
      if (b.logo) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = b.logo;
        n.appendChild(img);
      } else {
        n.innerHTML = DEFAULT_MARK;
      }
    });
    document.querySelectorAll("[data-brand-tagline]").forEach(function (n) {
      n.textContent = b.tagline || "";
      n.hidden = !b.tagline;
    });
    let link = document.querySelector('link[rel="icon"]');
    if (b.favicon) {
      if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
      link.href = b.favicon;
    } else if (link) { link.remove(); }
    if (currentView === "terms" && typeof populateTermsView === "function") {
      populateTermsView();
    }
  }
  function renderAdminBranding() {
    const m = mountFor("branding");
    m.innerHTML = "";
    const b = platformSettings.branding;
    const grid = el("div", "admin-grid");
    grid.appendChild(adminField("App name", adminText("admin-brand-appname", b.appName)));
    grid.appendChild(adminField("Short tagline", adminText("admin-brand-tagline", b.tagline, "optional")));
    m.appendChild(grid);

    ["logo", "logo2", "favicon"].forEach(function (key) {
      const box = el("div", "admin-price-box");
      box.appendChild(el("h3", "tp-section__title", key === "logo" ? "Primary logo" : key === "logo2" ? "Secondary logo" : "Favicon"));
      const file = document.createElement("input");
      file.type = "file";
      file.id = "admin-brand-" + key + "-file";
      file.accept = "image/png,image/jpeg,image/webp";
      box.appendChild(file);
      box.appendChild(el("p", "field__hint", "PNG, JPEG or WebP · up to 2 MB (favicon 512 KB) · square works best."));
      const err = el("p", "field__error");
      err.id = "admin-brand-" + key + "-error";
      err.hidden = true;
      box.appendChild(err);
      const prev = el("div", "admin-preview");
      prev.id = "admin-brand-" + key + "-preview";
      prev.innerHTML = b[key] ? '<img alt="" src="' + b[key] + '" />' : '<span class="field__hint">Default mark in use</span>';
      box.appendChild(prev);
      const acts = el("div", "form__actions");
      const reset = el("button", "btn btn--ghost");
      reset.type = "button";
      reset.setAttribute("data-admin-brand-reset", key);
      reset.innerHTML = '<span class="btn__label">Reset to default</span>';
      acts.appendChild(reset);
      box.appendChild(acts);
      m.appendChild(box);
    });

    m.appendChild(adminActions("Publish branding", "data-admin-save-branding"));
    m.appendChild(el("p", "field__hint",
      "Publishing applies the name, logo and favicon across the header, both dashboards, the " +
      "admin panel and the sign-in pages."));
    m.appendChild(el("p", "field__hint",
      "Selected images are uploaded to server-side storage when you publish. The server checks " +
      "type, size and dimensions, so a rejected file leaves the existing image in place."));
  }

  async function uploadPendingBrandFiles() {
    const slots = Object.keys(pendingBrandFiles);
    for (const slot of slots) {
      const file = pendingBrandFiles[slot];
      if (!file) continue;
      const form = new FormData();
      form.append("slot", slot);
      form.append("image", file, file.name || slot);
      await apiRequest("/admin/branding/upload", { method: "POST", body: form });
      delete pendingBrandFiles[slot];
    }
  }

  /* ===================== GENERAL PLATFORM SETTINGS ==================== */
  function renderAdminNotifications() {
    const m = mountFor("notifications");
    if (!m) return;
    m.innerHTML = "";
    const n = notifSettings();
    m.appendChild(el("p", "field__hint",
      "Only in-app notifications are implemented. No email, SMS, WhatsApp or push channel is " +
      "configured, so none is offered here as if it worked."));
    m.appendChild(el("h3", "tp-section__title", "Categories"));
    Object.keys(NOTIFICATION_CATEGORIES).forEach(function (cat) {
      m.appendChild(adminToggle("admin-notif-" + cat, NOTIFICATION_CATEGORIES[cat], n.enabled[cat] !== false,
        "Disabling a category stops new notifications of that kind. Existing notifications are kept."));
    });
    m.appendChild(el("h3", "tp-section__title", "Attendance reminders"));
    const grid = el("div", "admin-grid");
    grid.appendChild(adminField("Send the first reminder after (hours)", adminNumber("admin-notif-delay", n.reminderDelayHours, 0, 168)));
    grid.appendChild(adminField("Minimum hours between reminders", adminNumber("admin-notif-interval", n.reminderIntervalHours, 1, 168)));
    grid.appendChild(adminField("Maximum reminders per record", adminNumber("admin-notif-max", n.maxReminderAttempts, 1, 10)));
    m.appendChild(grid);
    m.appendChild(el("p", "field__hint",
      "Reminders stop once the student confirms or disputes, or when the record is under review. " +
      "A reminder never confirms attendance by itself."));
    m.appendChild(adminToggle("admin-notif-admins", "Notify admins when a dispute is opened", n.notifyAdminsOnDispute));
    m.appendChild(adminToggle("admin-notif-resolve", "Notify both parties when a case is resolved", n.notifyPartiesOnResolution));
    const acts = el("div", "form__actions");
    const save = el("button", "btn btn--primary");
    save.type = "button";
    save.setAttribute("data-admin-save-notifications", "1");
    save.innerHTML = '<span class="btn__label">Save notification settings</span>';
    const run = el("button", "btn btn--ghost");
    run.type = "button";
    run.setAttribute("data-admin-run-reminders", "1");
    run.innerHTML = '<span class="btn__label">Run attendance reminders now</span>';
    acts.appendChild(save);
    acts.appendChild(run);
    m.appendChild(acts);
    m.appendChild(el("p", "field__hint",
      "Reminders are generated on the server by the routine below, which is safe to run " +
      "repeatedly — it will not create a duplicate for a record it has already reminded."));
    const s = attendanceStats(attendance);
    m.appendChild(el("p", "field__hint",
      "Current queue: " + attendanceReminderCandidates().length + " reminder(s) due out of " +
      s.pending + " pending record(s)."));
  }

  function renderAdminSettings() {
    const m = mountFor("settings");
    m.innerHTML = "";
    const g = platformSettings.general;
    m.appendChild(adminField("App name", adminText("admin-gen-name", g.appName)));
    m.appendChild(adminToggle("admin-gen-signup", "Allow new student signups", g.supportSignup));
    m.appendChild(adminToggle("admin-gen-teachersignup", "Allow new teacher signups", g.teacherSignup));
    m.appendChild(adminToggle("admin-gen-bookings", "Accept new bookings", g.newBookingsAccepted));
    m.appendChild(adminToggle("admin-gen-approval", "Require admin approval for new teachers", g.teacherApprovalRequired));
    m.appendChild(adminToggle("admin-gen-require-docs", "Require teacher ID & qualification verification", g.requireTeacherDocumentVerification !== false,
      "When enabled, teachers are prompted to upload government ID and qualification documents, and profiles display a verified badge once approved. When disabled, document upload is removed from teachers."));
    m.appendChild(adminToggle("admin-gen-maintenance", "Maintenance mode", g.maintenanceMode,
      "While on, only administrators can use the platform. Sign-in, health and settings stay reachable so you can switch it back off."));
    m.appendChild(adminField("Maintenance notice", adminText("admin-gen-maintenance-notice", g.maintenanceNotice),
      "Shown to everyone while maintenance mode is on."));
    m.appendChild(adminActions("Save general settings", "data-admin-save-general"));
  }

  /* ========================= REVIEW MODERATION ======================== */
  const REVIEW_STATUS_LABELS = {
    published: "Published",
    hidden: "Hidden",
    flagged: "Flagged for review",
  };

  function renderAdminModeration() {
    const m = mountFor("moderation");
    m.innerHTML = "";
    if (!reviews.length) {
      m.appendChild(adminEmpty("No reviews to moderate",
        "Reviews appear here once a student has submitted one."));
      return;
    }
    const list = el("div", "bk-list");
    reviews.forEach(function (r) {
      const card = el("article", "bkcard");
      card.appendChild(el("h3", "bkcard__teacher", r.teacherName + " · " + r.rating + "/5"));
      card.appendChild(el("p", "bkcard__meta", r.studentName || "Student"));
      card.appendChild(el("p", "bkcard__note", r.text));
      const facts = el("div", "bkcard__facts");
      const f = el("div", "bkcard__fact");
      f.appendChild(el("p", "bkcard__fact-label", "Moderation status"));
      f.appendChild(el("p", "bkcard__fact-value", REVIEW_STATUS_LABELS[r.status] || r.status || "Published"));
      facts.appendChild(f);
      if (r.moderationNote) {
        const n = el("div", "bkcard__fact");
        n.appendChild(el("p", "bkcard__fact-label", "Moderator note"));
        n.appendChild(el("p", "bkcard__fact-value", r.moderationNote));
        facts.appendChild(n);
      }
      card.appendChild(facts);

      card.appendChild(adminField("Moderator note (optional)",
        adminText("admin-review-note-" + r.id, r.moderationNote || "", "Reason for this decision"), "Max 400 characters."));
      const acts = el("div", "bkcard__actions");
      [
        ["published", "Publish"],
        ["hidden", "Hide / reject"],
        ["flagged", "Flag for review"],
      ].forEach(function (pair) {
        const b = el("button", pair[0] === "published" ? "btn btn--primary" : "btn btn--ghost");
        b.type = "button";
        b.setAttribute("data-admin-review-status", r.id + ":" + pair[0]);
        b.innerHTML = '<span class="btn__label">' + pair[1] + "</span>";
        acts.appendChild(b);
      });
      card.appendChild(acts);
      list.appendChild(card);
    });
    m.appendChild(list);
    m.appendChild(el("p", "field__hint",
      "Every action calls the server. Hiding removes the review from public listings without " +
      "deleting it; the student is notified and the change is written to the audit trail."));
  }

  /* ========================= ATTENDANCE DISPUTES ====================== */
  function renderAdminDisputes() {
    const m = mountFor("disputes");
    m.innerHTML = "";
    const cases = reviewCases();
    m.appendChild(el("p", "ft-summary", cases.length
      ? cases.length + " case" + (cases.length === 1 ? "" : "s") + " awaiting a decision."
      : "Nothing is awaiting a decision."));
    if (!cases.length) {
      m.appendChild(adminEmpty("No open disputes",
        "Disputed attendance records and correction requests appear here and in the review console."));
    } else {
      const list = el("div", "bk-list");
      cases.forEach(function (c) {
        const card = el("article", "bkcard");
        card.appendChild(el("h3", "bkcard__teacher", (c.studentName || "Student") + " · " + c.teacherName));
        card.appendChild(el("p", "bkcard__meta", prettyDate(c.date) + " · " + attendanceStatusLabel(c)));
        card.appendChild(el("p", "bkcard__note", c.studentResponse || "No student explanation."));
        list.appendChild(card);
      });
      m.appendChild(list);
    }
    const acts = el("div", "form__actions");
    const open = el("button", "btn btn--primary");
    open.type = "button";
    open.setAttribute("data-admin-open-console", "1");
    open.innerHTML = '<span class="btn__label">Open the dispute review console</span>';
    acts.appendChild(open);
    m.appendChild(acts);
    m.appendChild(el("p", "field__hint",
      "Decisions are recorded in the audit history below and in the console, and never overwrite " +
      "the teacher's original attendance entry."));
  }

  /* ====================== ADMIN ROLES & PERMISSIONS =================== */
  function roleLabel(name) {
    const role = apiAdminRoles.filter(function (item) { return item.name === name; })[0];
    return role ? role.label : name;
  }

  function renderAdminRoles() {
    const m = mountFor("roles");
    m.innerHTML = "";
    const superAdmin = isSuperAdminSession();
    m.appendChild(el("p", "field__hint",
      "Roles are stored and enforced by the server. " +
      (superAdmin
        ? "As a Super Admin you may assign any role, including administrator roles."
        : "As an Admin you may assign non-privileged roles only; only a Super Admin can grant administrator access.")));
    m.appendChild(el("p", "field__hint",
      "Current session: " + roleLabel(superAdmin ? "super_admin" : "admin") + "."));

    if (!apiAdminRoles.length) {
      m.appendChild(adminEmpty("Roles unavailable",
        "The role list could not be loaded. No role changes are possible until it is available."));
      return;
    }
    if (!apiAdminUsers.length) {
      m.appendChild(adminEmpty("No accounts loaded",
        "Accounts could not be loaded, so no role can be changed from here."));
      return;
    }

    const options = apiAdminRoles
      .filter(function (role) { return superAdmin || !role.is_privileged; })
      .map(function (role) { return { value: role.name, label: role.label || role.name }; });

    const list = el("div", "bk-list");
    apiAdminUsers.forEach(function (user) {
      const card = el("article", "bkcard");
      const head = el("div", "bkcard__head");
      const idw = el("div", "bkcard__identity");
      idw.appendChild(el("h3", "bkcard__teacher", user.name));
      idw.appendChild(el("p", "bkcard__meta", user.email || "No email on record"));
      head.appendChild(idw);
      head.appendChild(el("span", "status status--accepted", roleLabel(user.role)));
      card.appendChild(head);

      const isSelf = sessionUser && String(sessionUser.id) === String(user.id);
      const select = adminSelect("admin-role-select-" + user.id, options, user.role);
      select.disabled = isSelf;
      card.appendChild(adminField("Assigned role", select,
        isSelf ? "You cannot change your own role from this screen." : "The server checks whether you may grant this role."));
      const acts = el("div", "bkcard__actions");
      const save = el("button", "btn btn--primary");
      save.type = "button";
      save.setAttribute("data-admin-role-save", user.id);
      save.disabled = isSelf;
      save.innerHTML = '<span class="btn__label">Update role</span>';
      acts.appendChild(save);
      card.appendChild(acts);
      list.appendChild(card);
    });
    m.appendChild(list);

    // Creating an account. The server owns the rules: an ordinary Admin may
    // only create the roles that are not privileged, and the panel therefore
    // offers the same set.
    m.appendChild(el("h3", "tp-section__title", "Create an account"));
    m.appendChild(el("p", "field__hint",
      "The account is created on the server with the role you choose. " +
      (superAdmin
        ? "As a Super Admin you may create any role, including administrator roles."
        : "As an Admin you may create student and teacher accounts only.")));
    const createGrid = el("div", "admin-grid");
    const createName = adminText("admin-create-name", "");
    const createEmail = adminText("admin-create-email", "");
    const createPassword = adminText("admin-create-password", "");
    const createRole = adminSelect("admin-create-role", options, options.length ? options[0].value : "student");
    createGrid.appendChild(adminField("Full name", createName));
    createGrid.appendChild(adminField("Email address", createEmail));
    createGrid.appendChild(adminField("Password", createPassword, "At least 12 characters."));
    createGrid.appendChild(adminField("Role", createRole));
    m.appendChild(createGrid);
    const createActions = el("div", "bkcard__actions");
    const createBtn = el("button", "btn btn--primary");
    createBtn.type = "button";
    createBtn.setAttribute("data-admin-create-user", "1");
    createBtn.innerHTML = '<span class="btn__label">Create account</span>';
    createActions.appendChild(createBtn);
    m.appendChild(createActions);
  }

  /* ============================ AUDIT HISTORY ========================= */
  function mapAuditLogs(logs, append) {
    adminAuditLoaded = true;
    if (!append) replaceArray(adminAudit, []);
    (logs || []).forEach(function (log) {
      adminAudit.push({
        id: log.id,
        entity: (log.entity_type || "Record").split("\\").pop() + " " + (log.entity_id || ""),
        field: log.action || "change",
        oldValue: log.old_values ? JSON.stringify(log.old_values) : "(none)",
        newValue: log.new_values ? JSON.stringify(log.new_values) : "(none)",
        rawOld: log.old_values,
        rawNew: log.new_values,
        actorId: log.actor_name || log.actor_id,
        actorRawId: log.actor_id,
        at: log.created_at || "",
        note: log.reason || "",
      });
    });
  }

  function formatAuditChangeSummary(a) {
    let oldObj = a.rawOld;
    let newObj = a.rawNew;
    if (typeof oldObj === "string" && oldObj.indexOf("{") === 0) {
      try { oldObj = JSON.parse(oldObj); } catch (e) {}
    }
    if (typeof newObj === "string" && newObj.indexOf("{") === 0) {
      try { newObj = JSON.parse(newObj); } catch (e) {}
    }
    if (oldObj && newObj && typeof oldObj === "object" && typeof newObj === "object" && !Array.isArray(oldObj) && !Array.isArray(newObj)) {
      const diffs = [];
      const keys = Object.keys(Object.assign({}, oldObj, newObj));
      keys.forEach(function (k) {
        const v1 = JSON.stringify(oldObj[k]);
        const v2 = JSON.stringify(newObj[k]);
        if (v1 !== v2) {
          const s1 = oldObj[k] === null || oldObj[k] === undefined ? "null" : JSON.stringify(oldObj[k]);
          const s2 = newObj[k] === null || newObj[k] === undefined ? "null" : JSON.stringify(newObj[k]);
          diffs.push(k + ": " + (s1.length > 35 ? s1.substring(0, 32) + "…" : s1) + " → " + (s2.length > 35 ? s2.substring(0, 32) + "…" : s2));
        }
      });
      if (diffs.length > 0) {
        if (diffs.length <= 3) return diffs.join("; ");
        return diffs.slice(0, 3).join("; ") + " (+" + (diffs.length - 3) + " more)";
      }
    }
    const sOld = a.oldValue && a.oldValue !== "(none)" ? a.oldValue : "(none)";
    const sNew = a.newValue && a.newValue !== "(none)" ? a.newValue : "(none)";
    let fallback = sOld + " → " + sNew;
    if (fallback.length > 150) {
      return fallback.substring(0, 147) + "…";
    }
    return fallback;
  }

  // Re-read the server audit log. Decisions taken in the review console and
  // changes made in another tab are only visible after this call.
  // The audit log is filtered by the server, so the panel can show one
  // administrator's actions or one kind of action at a time.
  let adminAuditFilters = { action: "", actor_id: "", search: "" };
  let adminAuditPage = 1;
  let adminAuditTotal = 0;

  async function refreshAdminAudit(page) {
    try {
      const wanted = page || adminAuditPage;
      const params = ["per_page=20", "page=" + wanted];
      if (adminAuditFilters.action) params.push("action=" + encodeURIComponent(adminAuditFilters.action));
      if (adminAuditFilters.actor_id) params.push("actor_id=" + encodeURIComponent(adminAuditFilters.actor_id));
      if (adminAuditFilters.search) params.push("search=" + encodeURIComponent(adminAuditFilters.search));
      const payload = await apiRequest("/admin/audit-logs?" + params.join("&"));
      mapAuditLogs(payload.data || [], wanted > 1);
      adminAuditPage = wanted;
      adminAuditTotal = (payload.meta && payload.meta.total) || 0;
      if (payload.meta && Array.isArray(payload.meta.available_actions)) {
        availableAuditActions = payload.meta.available_actions;
      }
      if (adminSection === "overview") renderAdminOverview();
      const m = mountFor("audit");
      if (m && adminSection === "audit") renderAdminAudit();
      return true;
    } catch (error) {
      return false;
    }
  }
  function renderAdminAudit() {
    const m = mountFor("audit");
    m.innerHTML = "";
    if (!adminAuditLoaded) {
      m.appendChild(adminEmpty("Audit history unavailable",
        "The server audit log could not be loaded. No local substitute is shown."));
      return;
    }

    // Header actions
    const auditHead = el("div");
    auditHead.style.display = "flex";
    auditHead.style.justifyContent = "space-between";
    auditHead.style.alignItems = "center";
    auditHead.style.marginBottom = "14px";
    auditHead.style.flexWrap = "wrap";
    auditHead.style.gap = "8px";

    const titleH = el("h3", "tp-section__title", "Audit Logs & Administrative Trail");
    titleH.style.margin = "0";
    auditHead.appendChild(titleH);

    if (adminAudit.length > 0 || adminAuditTotal > 0) {
      const clearAllBtn = el("button", "btn btn--ghost");
      clearAllBtn.type = "button";
      clearAllBtn.setAttribute("data-admin-audit-clear-logs", "1");
      clearAllBtn.style.color = "var(--danger, #d92d20)";
      clearAllBtn.style.borderColor = "rgba(217, 45, 32, 0.4)";
      clearAllBtn.innerHTML = '<span class="btn__label">Clear all logs</span>';
      auditHead.appendChild(clearAllBtn);
    }
    m.appendChild(auditHead);

    // The filters, applied by the server.
    const actionInput = document.createElement("input");
    actionInput.type = "text";
    actionInput.id = "admin-audit-action";
    actionInput.value = adminAuditFilters.action;
    actionInput.placeholder = "e.g. settings.updated, teacher.profile_updated";
    m.appendChild(adminField("Action contains", actionInput, "Filter by action keyword or name."));

    const actorSelect = document.createElement("select");
    actorSelect.id = "admin-audit-actor";
    const anyOption = document.createElement("option");
    anyOption.value = "";
    anyOption.textContent = "Any administrator";
    actorSelect.appendChild(anyOption);
    apiAdminUsers.forEach(function (u) {
      const option = document.createElement("option");
      option.value = String(u.id);
      option.textContent = u.name + (u.email ? " (" + u.email + ")" : "");
      actorSelect.appendChild(option);
    });
    actorSelect.value = adminAuditFilters.actor_id;
    m.appendChild(adminField("Administrator", actorSelect, "Show only the actions of one account."));

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.id = "admin-audit-search";
    searchInput.value = adminAuditFilters.search || "";
    searchInput.placeholder = "e.g. bio, reason, TeacherProfile";
    m.appendChild(adminField("Search keywords", searchInput, "Search text across entity, reason, and changed values."));

    const btnRow = el("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.alignItems = "center";
    btnRow.style.marginBottom = "16px";

    const clear = el("button", "btn btn--ghost");
    clear.type = "button";
    clear.setAttribute("data-admin-audit-clear", "1");
    clear.innerHTML = '<span class="btn__label">Clear filters</span>';
    btnRow.appendChild(clear);
    m.appendChild(btnRow);

    const all = adminAudit.slice();
    if (!all.length) {
      m.appendChild(adminEmpty("No administrative changes recorded",
        "Server-side changes are appended here with the old value, new value and administrator."));
      return;
    }
    const list = el("div", "bk-list");
    all.forEach(function (a) {
      const card = el("article", "bkcard");
      card.appendChild(el("h3", "bkcard__teacher", a.entity + " · " + a.field));
      const facts = el("div", "bkcard__facts");
      const summaryText = formatAuditChangeSummary(a);
      [["Change", summaryText],
       ["Previous", a.oldValue || "(none)"], ["New", a.newValue || "(none)"],
       ["Administrator", a.actorId], ["When", a.at ? new Date(a.at).toLocaleString() : ""],
       ["Reference", a.id]].forEach(function (p) {
        const r = el("div", "bkcard__fact");
        r.appendChild(el("p", "bkcard__fact-label", p[0]));
        r.appendChild(el("p", "bkcard__fact-value", p[1]));
        facts.appendChild(r);
      });
      card.appendChild(facts);
      if (a.note) card.appendChild(el("p", "bkcard__note", a.note));
      list.appendChild(card);
    });
    m.appendChild(list);
    // The log is read page by page, so a long history is never silently cut.
    m.appendChild(el("p", "field__hint",
      "Showing " + adminAudit.length + " of " + adminAuditTotal + " entries."));
    if (adminAudit.length < adminAuditTotal) {
      const more = el("button", "btn btn--ghost");
      more.type = "button";
      more.setAttribute("data-admin-audit-more", "1");
      more.innerHTML = '<span class="btn__label">Load more entries</span>';
      m.appendChild(more);
    }
    m.appendChild(el("p", "field__hint",
      "Audit entries never contain passwords, API secrets or OTP values, and they never rewrite " +
      "the original attendance, review or acceptance records."));
  }

  /* ======================== ADMIN BOOKINGS ========================== */
  // An administrator may cancel a booking: the booking endpoint accepts it and
  // both sides are told. The lesson itself is never deleted - the attendance
  // and the review of it stay exactly as they are.
  function adminBookingCancellable(booking) {
    if (!booking) return false;
    if (booking.status === "pending") return true;
    if (booking.status !== "accepted") return false;
    const parts = String(booking.date).split("-");
    if (parts.length !== 3) return false;
    const when = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(when.getTime())) return false;
    when.setHours(Number(booking.time.split(":")[0] || 0), Number(booking.time.split(":")[1] || 0), 0, 0);
    return when.getTime() > Date.now();
  }

  let adminBookingsStatus = "";
  let adminBookingsQuery = "";
  let adminBookingsPage = 1;
  let adminBookingsPages = 1;
  let adminBookingsTotal = 0;
  let adminBookingsLoading = false;
  let adminBookingsTimer = null;
  // The number of the request that is on its way. A search that is changed
  // while a request is running makes a newer one, and the older answer must
  // not be allowed to put the old results back on the screen.
  let adminBookingsRequest = 0;

  // The line that says which page is on screen and how many bookings the
  // search and the status filter found.
  function adminPageInfo() {
    return el("p", "field__hint",
      "Page " + adminBookingsPage + " of " + adminBookingsPages + " · " + adminBookingsTotal + " booking" +
      (adminBookingsTotal === 1 ? "" : "s") + " match the search and the status filter.");
  }

  function mapAdminBooking(b) {
    return {
      id: b.id,
      reference: b.reference || "",
      studentName: b.student_name || "",
      studentPhone: b.student_phone || "",
      studentEmail: b.student_email || "",
      teacherName: b.teacher_name || "",
      teacherPhone: b.teacher_phone || "",
      teacherEmail: b.teacher_email || "",
      subject: b.subject || "",
      date: b.date || "",
      time: String(b.start_time || "").slice(0, 5),
      status: b.status || "",
      mode: b.teaching_mode || "",
      bookingType: b.booking_type || "demo",
      agreedPrice: b.agreed_price !== null && b.agreed_price !== undefined ? Number(b.agreed_price) : null,
      pricingType: b.pricing_type || "",
      adminNotes: b.admin_notes || "",
      message: b.message || "",
      approvedAt: b.approved_at || "",
    };
  }

  // The list is read from the server with the search, the status filter and
  // the page, so what is on screen is always what the server holds.
  async function refreshAdminBookings(options) {
    const opts = options || {};
    if (opts.status !== undefined) adminBookingsStatus = opts.status;
    if (opts.query !== undefined) adminBookingsQuery = opts.query;
    if (opts.page !== undefined) adminBookingsPage = Math.max(1, opts.page);

    const params = ["per_page=10"];
    if (adminBookingsStatus) params.push("status=" + encodeURIComponent(adminBookingsStatus));
    if (adminBookingsQuery) params.push("q=" + encodeURIComponent(adminBookingsQuery));
    params.push("page=" + adminBookingsPage);

    adminBookingsLoading = true;
    renderAdminBookings();
    const request = ++adminBookingsRequest;
    try {
      const payload = await apiRequest("/admin/bookings?" + params.join("&"));
      // A newer search has already been asked for, so this answer is not the
      // one the administrator is waiting for.
      if (request !== adminBookingsRequest) return;
      apiAdminBookings = (payload.data || []).map(mapAdminBooking);
      const meta = payload.meta || {};
      adminBookingsPage = Math.max(1, Number(meta.current_page || 1));
      adminBookingsPages = Math.max(1, Number(meta.last_page || 1));
      adminBookingsTotal = Number(meta.total || apiAdminBookings.length);
    } catch (error) {
      if (request !== adminBookingsRequest) return;
      apiAdminBookings = [];
      adminBookingsPages = 1;
      adminBookingsTotal = 0;
      adminToast(apiErrorMessage(error));
    } finally {
      if (request === adminBookingsRequest) adminBookingsLoading = false;
    }
    renderAdminBookings();
  }

  function openAdminBookingApprovalModal(b) {
    var overlay = el("div", "data-dialog");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var panel = el("div", "data-dialog__panel storage-modal-wide");
    panel.style.maxWidth = "560px";

    var head = el("div", "panel__head");
    var titles = el("div");
    titles.appendChild(el("h3", "data-dialog__title", "Approve & Assign Tuition"));
    titles.appendChild(el("p", "data-dialog__text", "Reference " + b.reference + " · " + b.subject));
    head.appendChild(titles);
    panel.appendChild(head);

    var info = el("div", "tp-section");
    info.style.marginBottom = "16px";
    info.style.padding = "14px";
    info.style.background = "var(--surface-soft)";
    info.style.borderRadius = "8px";

    var planText = b.bookingType === "monthly" ? "Monthly Regular Tuition" :
                   b.bookingType === "course" ? "Full Course Package" : "Trial / Demo Lesson";
    var infoHtml = "<strong>Student:</strong> " + escapeHtml(b.studentName) + "<br>" +
                   "<strong>Contact:</strong> " + (b.studentPhone ? ('<a href="tel:' + escapeHtml(b.studentPhone) + '">' + escapeHtml(b.studentPhone) + '</a>') : "No phone provided") + "<br>" +
                   "<strong>Teacher:</strong> " + escapeHtml(b.teacherName) + "<br>" +
                   "<strong>Plan:</strong> " + planText + "<br>" +
                   "<strong>Subject & Mode:</strong> " + escapeHtml(b.subject) + " (" + escapeHtml(b.mode) + ")<br>" +
                   "<strong>Preferred Start:</strong> " + prettyDate(b.date) + " at " + b.time;
    if (b.message) {
      infoHtml += "<br><strong>Student Goals/Notes:</strong> <em>" + escapeHtml(b.message) + "</em>";
    }
    info.innerHTML = infoHtml;
    panel.appendChild(info);

    var form = el("form");
    form.onsubmit = function (e) { e.preventDefault(); };

    var grid = el("div", "book-grid-plan");
    grid.style.marginBottom = "14px";

    var feeGroup = el("div", "field");
    feeGroup.appendChild(el("label", "field__label", "Agreed Fee (₹)"));
    var feeCtrl = el("div", "field__control");
    var feeInput = document.createElement("input");
    feeInput.type = "number";
    feeInput.step = "any";
    feeInput.placeholder = "e.g. 5000";
    if (b.agreedPrice) feeInput.value = b.agreedPrice;
    feeCtrl.appendChild(feeInput);
    feeGroup.appendChild(feeCtrl);
    grid.appendChild(feeGroup);

    var typeGroup = el("div", "field");
    typeGroup.appendChild(el("label", "field__label", "Fee Model"));
    var typeCtrl = el("div", "field__control");
    var typeSelect = document.createElement("select");
    [
      ["monthly", "Per Month (Monthly Tuition)"],
      ["course", "Total Course Package Fee"],
      ["hourly", "Per Hour / Lesson Fee"],
      ["custom", "Custom Agreed Terms"]
    ].forEach(function (opt) {
      var op = document.createElement("option");
      op.value = opt[0];
      op.textContent = opt[1];
      if (b.pricingType === opt[0] || (!b.pricingType && b.bookingType === opt[0])) op.selected = true;
      typeSelect.appendChild(op);
    });
    typeCtrl.appendChild(typeSelect);
    typeGroup.appendChild(typeCtrl);
    grid.appendChild(typeGroup);
    form.appendChild(grid);

    var notesGroup = el("div", "field");
    notesGroup.appendChild(el("label", "field__label", "Coordinator Call Notes"));
    var notesCtrl = el("div", "field__control");
    var notesInput = document.createElement("textarea");
    notesInput.rows = 3;
    notesInput.maxLength = 500;
    notesInput.placeholder = "e.g. Spoke with student/parent on call. Finalized 12 classes/month at ₹5,000/month. Ready to start.";
    if (b.adminNotes) notesInput.value = b.adminNotes;
    notesCtrl.appendChild(notesInput);
    notesGroup.appendChild(notesCtrl);
    form.appendChild(notesGroup);
    panel.appendChild(form);

    var actions = el("div", "data-dialog__actions");
    actions.style.marginTop = "20px";
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "10px";

    var cancelBtn = el("button", "btn btn--ghost");
    cancelBtn.type = "button";
    cancelBtn.innerHTML = '<span class="btn__label">Cancel</span>';
    cancelBtn.onclick = function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    actions.appendChild(cancelBtn);

    var approveBtn = el("button", "btn btn--primary");
    approveBtn.type = "button";
    approveBtn.innerHTML = '<span class="btn__label">✓ Confirm &amp; Assign to Teacher</span>';
    approveBtn.onclick = function () {
      approveBtn.disabled = true;
      approveBtn.innerHTML = '<span class="btn__label">Approving...</span>';
      apiRequest("/admin/bookings/" + encodeURIComponent(b.id) + "/approve", {
        method: "PATCH",
        body: {
          agreed_price: feeInput.value ? Number(feeInput.value) : null,
          pricing_type: typeSelect.value,
          admin_notes: notesInput.value.trim() || null,
        },
      })
        .then(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          adminToast("Booking approved and dispatched to teacher!");
          return refreshAdminBookings();
        })
        .catch(function (err) {
          adminToast(apiErrorMessage(err));
          approveBtn.disabled = false;
          approveBtn.innerHTML = '<span class="btn__label">✓ Confirm &amp; Assign to Teacher</span>';
        });
    };
    actions.appendChild(approveBtn);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    feeInput.focus();
  }

  function openAdminBookingFeeModal(b) {
    var overlay = el("div", "data-dialog");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var panel = el("div", "data-dialog__panel storage-modal-wide");
    panel.style.maxWidth = "520px";

    var head = el("div", "panel__head");
    var titles = el("div");
    titles.appendChild(el("h3", "data-dialog__title", "Set / Edit Agreed Fee"));
    titles.appendChild(el("p", "data-dialog__text", "Booking " + b.reference + " · " + b.studentName + " with " + b.teacherName));
    head.appendChild(titles);
    panel.appendChild(head);

    var form = el("form");
    form.onsubmit = function (e) { e.preventDefault(); };

    var grid = el("div", "book-grid-plan");
    grid.style.marginBottom = "14px";

    var feeGroup = el("div", "field");
    feeGroup.appendChild(el("label", "field__label", "Agreed Fee (₹)"));
    var feeCtrl = el("div", "field__control");
    var feeInput = document.createElement("input");
    feeInput.type = "number";
    feeInput.step = "any";
    feeInput.placeholder = "e.g. 6000";
    if (b.agreedPrice) feeInput.value = b.agreedPrice;
    feeCtrl.appendChild(feeInput);
    feeGroup.appendChild(feeCtrl);
    grid.appendChild(feeGroup);

    var typeGroup = el("div", "field");
    typeGroup.appendChild(el("label", "field__label", "Fee Model"));
    var typeCtrl = el("div", "field__control");
    var typeSelect = document.createElement("select");
    [
      ["monthly", "Per Month (Monthly Tuition)"],
      ["course", "Total Course Package Fee"],
      ["hourly", "Per Hour / Lesson Fee"],
      ["custom", "Custom Agreed Terms"]
    ].forEach(function (opt) {
      var op = document.createElement("option");
      op.value = opt[0];
      op.textContent = opt[1];
      if (b.pricingType === opt[0] || (!b.pricingType && b.bookingType === opt[0])) op.selected = true;
      typeSelect.appendChild(op);
    });
    typeCtrl.appendChild(typeSelect);
    typeGroup.appendChild(typeCtrl);
    grid.appendChild(typeGroup);
    form.appendChild(grid);

    var notesGroup = el("div", "field");
    notesGroup.appendChild(el("label", "field__label", "Coordinator Call Notes"));
    var notesCtrl = el("div", "field__control");
    var notesInput = document.createElement("textarea");
    notesInput.rows = 3;
    notesInput.maxLength = 500;
    notesInput.placeholder = "e.g. Rate finalized on call with parent: ₹6,000 per month.";
    if (b.adminNotes) notesInput.value = b.adminNotes;
    notesCtrl.appendChild(notesInput);
    notesGroup.appendChild(notesCtrl);
    form.appendChild(notesGroup);
    panel.appendChild(form);

    var actions = el("div", "data-dialog__actions");
    actions.style.marginTop = "20px";
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "10px";

    var cancelBtn = el("button", "btn btn--ghost");
    cancelBtn.type = "button";
    cancelBtn.innerHTML = '<span class="btn__label">Cancel</span>';
    cancelBtn.onclick = function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    actions.appendChild(cancelBtn);

    var saveBtn = el("button", "btn btn--primary");
    saveBtn.type = "button";
    saveBtn.innerHTML = '<span class="btn__label">Save Fee &amp; Notes</span>';
    saveBtn.onclick = function () {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="btn__label">Saving...</span>';
      apiRequest("/admin/bookings/" + encodeURIComponent(b.id) + "/pricing", {
        method: "PATCH",
        body: {
          agreed_price: feeInput.value ? Number(feeInput.value) : null,
          pricing_type: typeSelect.value,
          admin_notes: notesInput.value.trim() || null,
        },
      })
        .then(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          adminToast("Agreed fee and notes saved successfully!");
          return refreshAdminBookings();
        })
        .catch(function (err) {
          adminToast(apiErrorMessage(err));
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<span class="btn__label">Save Fee &amp; Notes</span>';
        });
    };
    actions.appendChild(saveBtn);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    feeInput.focus();
  }

  function renderAdminBookings() {
    const m = mountFor("bookings");
    if (!m) return;
    m.innerHTML = "";

    // The filter is the server's filter, so the list always matches it.
    const filter = el("div", "admin-grid");
    const statusSelect = document.createElement("select");
    statusSelect.id = "admin-bookings-status";
    [["", "Every status"], ["pending", "Pending Review"], ["accepted", "Accepted / Assigned"], ["completed", "Completed"],
     ["rejected", "Rejected"], ["cancelled", "Cancelled"]].forEach(function (option) {
      const node = document.createElement("option");
      node.value = option[0];
      node.textContent = option[1];
      statusSelect.appendChild(node);
    });
    statusSelect.value = adminBookingsStatus;
    filter.appendChild(adminField("Status", statusSelect));

    const search = document.createElement("input");
    search.id = "admin-bookings-search";
    search.type = "search";
    search.className = "input";
    search.placeholder = "Reference, student, phone, teacher or subject";
    search.value = adminBookingsQuery;
    filter.appendChild(adminField("Search bookings", search));
    m.appendChild(filter);

    if (adminBookingsLoading) {
      m.appendChild(el("p", "field__hint", "Loading the bookings…"));
    }

    if (!apiAdminBookings.length) {
      if (adminBookingsQuery || adminBookingsStatus) {
        m.appendChild(adminEmpty(
          "No bookings match",
          "No booking matches the search and the status filter. Clear the search or choose another status."));
      } else {
        m.appendChild(adminEmpty("No bookings", "Bookings appear here as soon as a student requests a lesson."));
      }
      m.appendChild(adminPageInfo());
      return;
    }
    const list = el("div", "bk-list");
    apiAdminBookings.forEach(function (b) {
      const card = el("article", "bkcard");

      const head = el("div", "bkcard__head");
      head.style.display = "flex";
      head.style.alignItems = "center";
      head.style.justifyContent = "space-between";
      head.style.flexWrap = "wrap";
      head.style.gap = "8px";
      head.style.marginBottom = "10px";

      const title = el("h3", "bkcard__teacher", b.reference + " · " + b.teacherName);
      head.appendChild(title);

      const planWrap = el("div");
      planWrap.style.display = "flex";
      planWrap.style.alignItems = "center";
      planWrap.style.gap = "6px";

      const planTag = el("span", "tag " + (
        b.bookingType === "monthly" ? "tag--plan-monthly" :
        b.bookingType === "course" ? "tag--plan-course" : "tag--plan-demo"
      ));
      planTag.textContent = b.bookingType === "monthly" ? "Monthly Regular Tuition" :
        b.bookingType === "course" ? "Full Course Package" : "Trial / Demo Lesson";
      planWrap.appendChild(planTag);
      head.appendChild(planWrap);
      card.appendChild(head);

      const facts = el("div", "bkcard__facts");

      // 1. Student
      const rStudent = el("div", "bkcard__fact");
      rStudent.appendChild(el("p", "bkcard__fact-label", "Student"));
      rStudent.appendChild(el("p", "bkcard__fact-value", b.studentName));
      facts.appendChild(rStudent);

      // 2. Student Contact (Phone + WhatsApp + Call)
      const rContact = el("div", "bkcard__fact");
      rContact.appendChild(el("p", "bkcard__fact-label", "Student Contact"));
      const rContactVal = el("p", "bkcard__fact-value");
      if (b.studentPhone) {
        const clean = b.studentPhone.replace(/[^\d]/g, "");
        const waPhone = clean.length === 10 ? ("91" + clean) : clean;
        const brandName = (platformSettings && platformSettings.branding && platformSettings.branding.appName) || "EduPlatform";
        const msg = encodeURIComponent("Hello " + b.studentName + ", this is " + brandName + " Academic Team regarding your " +
          (b.bookingType === "monthly" ? "monthly tuition" : "course") + " inquiry for " + b.subject + " with " + b.teacherName + ".");
        rContactVal.innerHTML = '<span style="font-weight:600;">' + escapeHtml(b.studentPhone) + '</span> ' +
          '<a href="https://wa.me/' + waPhone + '?text=' + msg + '" target="_blank" rel="noopener noreferrer" class="bkcard__whatsapp" title="Chat on WhatsApp">WhatsApp</a> ' +
          '<a href="tel:' + escapeHtml(b.studentPhone) + '" class="bkcard__call" title="Call student">Call</a>';
      } else {
        rContactVal.textContent = b.studentEmail || "No phone on record";
      }
      rContact.appendChild(rContactVal);
      facts.appendChild(rContact);

      // 3. Subject & Mode
      const rSubj = el("div", "bkcard__fact");
      rSubj.appendChild(el("p", "bkcard__fact-label", "Subject & Mode"));
      rSubj.appendChild(el("p", "bkcard__fact-value", b.subject + " (" + (b.mode === "online" ? "Online" : "In-person") + ")"));
      facts.appendChild(rSubj);

      // 4. Starting Schedule
      const rWhen = el("div", "bkcard__fact");
      rWhen.appendChild(el("p", "bkcard__fact-label", "Start Schedule"));
      rWhen.appendChild(el("p", "bkcard__fact-value", prettyDate(b.date) + " at " + b.time));
      facts.appendChild(rWhen);

      // 5. Status
      const rStatus = el("div", "bkcard__fact");
      rStatus.appendChild(el("p", "bkcard__fact-label", "Status"));
      const rStatusVal = el("p", "bkcard__fact-value");
      if (b.status === "pending") {
        rStatusVal.innerHTML = '<span style="color:#b45309;font-weight:700;">Pending Coordinator Approval</span>';
      } else if (b.status === "accepted") {
        rStatusVal.innerHTML = '<span style="color:#047857;font-weight:700;">✓ Confirmed &amp; Assigned</span>';
      } else {
        rStatusVal.textContent = b.status;
      }
      rStatus.appendChild(rStatusVal);
      facts.appendChild(rStatus);

      // 6. Agreed Fee
      const rFee = el("div", "bkcard__fact");
      rFee.appendChild(el("p", "bkcard__fact-label", "Agreed Fee"));
      const rFeeVal = el("p", "bkcard__fact-value");
      if (b.agreedPrice) {
        rFeeVal.innerHTML = '<span class="bkcard__fee-badge">₹' + Number(b.agreedPrice).toLocaleString("en-IN") +
          ' (' + escapeHtml(b.pricingType || b.bookingType) + ')</span>';
      } else {
        rFeeVal.innerHTML = '<span style="color:var(--text-tertiary);font-style:italic;">Pending negotiation on call</span>';
      }
      rFee.appendChild(rFeeVal);
      facts.appendChild(rFee);

      // 7. Student Notes if present
      if (b.message) {
        const rMsg = el("div", "bkcard__fact");
        rMsg.style.gridColumn = "1 / -1";
        rMsg.appendChild(el("p", "bkcard__fact-label", "Student Goals / Requirements"));
        rMsg.appendChild(el("p", "bkcard__fact-value", '“' + escapeHtml(b.message) + '”'));
        facts.appendChild(rMsg);
      }

      // 8. Coordinator Notes if present
      if (b.adminNotes) {
        const rNotes = el("div", "bkcard__fact");
        rNotes.style.gridColumn = "1 / -1";
        rNotes.appendChild(el("p", "bkcard__fact-label", "Coordinator Call Notes"));
        rNotes.appendChild(el("p", "bkcard__fact-value", '📝 ' + escapeHtml(b.adminNotes)));
        facts.appendChild(rNotes);
      }

      card.appendChild(facts);

      // Action Buttons
      const actions = el("div", "bkcard__actions");
      actions.style.display = "flex";
      actions.style.flexWrap = "wrap";
      actions.style.gap = "8px";
      actions.style.alignItems = "center";

      if (b.status === "pending") {
        const approveBtn = el("button", "btn btn--primary");
        approveBtn.type = "button";
        approveBtn.setAttribute("data-admin-approve-booking", String(b.id));
        approveBtn.innerHTML = '<span class="btn__label">✓ Approve &amp; Assign to Teacher</span>';
        actions.appendChild(approveBtn);
      }

      const feeBtn = el("button", "btn btn--ghost");
      feeBtn.type = "button";
      feeBtn.setAttribute("data-admin-edit-fee", String(b.id));
      feeBtn.innerHTML = '<span class="btn__label">' + (b.agreedPrice ? 'Edit Agreed Fee' : 'Set Agreed Fee') + '</span>';
      actions.appendChild(feeBtn);

      if (adminBookingCancellable(b)) {
        const cancel = el("button", "btn btn--ghost");
        cancel.type = "button";
        cancel.setAttribute("data-admin-cancel-booking", "1");
        cancel.setAttribute("data-id", String(b.id));
        cancel.innerHTML = '<span class="btn__label">Cancel</span>';
        actions.appendChild(cancel);
      }

      card.appendChild(actions);
      list.appendChild(card);
    });
    m.appendChild(list);

    // The page controls. They say where the administrator is and how many
    // pages there are, and they keep the search and the status filter.
    const pages = el("div", "bkcard__actions");
    const previous = el("button", "btn btn--ghost");
    previous.type = "button";
    previous.setAttribute("data-admin-bookings-prev", "1");
    previous.disabled = adminBookingsPage <= 1;
    previous.innerHTML = '<span class="btn__label">Previous</span>';
    pages.appendChild(previous);
    const next = el("button", "btn btn--ghost");
    next.type = "button";
    next.setAttribute("data-admin-bookings-next", "1");
    next.disabled = adminBookingsPage >= adminBookingsPages;
    next.innerHTML = '<span class="btn__label">Next</span>';
    pages.appendChild(next);
    m.appendChild(pages);
    m.appendChild(adminPageInfo());
    m.appendChild(el("p", "field__hint",
      "Cancelling keeps the lesson on record. The attendance and the review of that lesson are never " +
      "changed, and both sides are told."));
  }

  /* ======================== ADMIN TEACHER OVERRIDES ================== */
  // The settings one teacher has overridden. They are read from the server, so
  // the panel always shows what the backend really applies.
  const ADMIN_OVERRIDE_KEYS = [
    { group: "attendance", key: "verificationEnabled", label: "Attendance recording",
      options: [["Platform default", ""], ["On", "true"], ["Off", "false"]] },
    { group: "attendance", key: "verificationMethod", label: "Confirmation method",
      options: [["Platform default", ""], ["Teacher and student", "teacher-and-student"], ["Teacher only", "teacher-only"]] },
    { group: "attendance", key: "requireReasonWhenLessonMissed", label: "Reason for a missed lesson",
      options: [["Platform default", ""], ["Required", "true"], ["Not required", "false"]] },
    { group: "eligibility", key: "configured", label: "Reviews for this teacher",
      options: [["Platform default", ""], ["Open", "true"], ["Locked", "false"]] },
    { group: "eligibility", key: "type", label: "Review policy",
      options: [["Platform default", ""], ["Study days", "study-days"], ["Completed lessons", "completed-lessons"]] },
    { group: "eligibility", key: "minConfirmedDays", label: "Minimum confirmed study days",
      options: [["Platform default", ""], ["1", "1"], ["2", "2"], ["3", "3"], ["5", "5"]] },
    { group: "eligibility", key: "minCompletedLessons", label: "Minimum completed lessons",
      options: [["Platform default", ""], ["1", "1"], ["2", "2"], ["3", "3"], ["5", "5"]] },
    { group: "eligibility", key: "requireCompletedBooking", label: "A completed lesson is required",
      options: [["Platform default", ""], ["Yes", "true"], ["No", "false"]] },
    { group: "pricing", key: "hourly", label: "Per-hour pricing for this teacher",
      options: [["Platform default", ""], ["Not offered", '{"enabled":false}']] },
    { group: "pricing", key: "monthly", label: "Monthly pricing for this teacher",
      options: [["Platform default", ""], ["Not offered", '{"enabled":false}']] },
    { group: "pricing", key: "course", label: "Full-course pricing for this teacher",
      options: [["Platform default", ""], ["Not offered", '{"enabled":false}']] },
  ];

  let adminTeacherOverrides = {};
  let adminOverridesOpen = "";

  async function loadAdminTeacherOverrides(teacherId) {
    const id = String(teacherId || "");
    if (!id) return;
    try {
      const payload = await apiRequest("/admin/teachers/" + encodeURIComponent(id) + "/overrides");
      const map = {};
      (payload.data || []).forEach(function (row) {
        if (!map[row.group]) map[row.group] = {};
        map[row.group][row.key] = row.value;
      });
      adminTeacherOverrides[id] = map;
    } catch (error) {
      adminTeacherOverrides[id] = {};
      adminToast(apiErrorMessage(error));
    }
    renderAdminTeacherOverrides();
  }

  function adminOverrideValue(teacherId, group, key) {
    const map = adminTeacherOverrides[String(teacherId)] || {};
    const groupMap = map[group] || {};
    return Object.prototype.hasOwnProperty.call(groupMap, key) ? groupMap[key] : undefined;
  }

  function renderAdminTeacherOverrides() {
    const host = document.getElementById("admin-overrides-panel");
    if (!host) return;
    host.innerHTML = "";
    const teacherId = String(adminOverridesOpen || "");
    if (!teacherId) return;
    const teacher = adminTeacherRows().filter(function (t) { return String(t.id) === teacherId; })[0];
    const title = el("h3", "tp-section__title", "Settings overrides for " + (teacher ? teacher.name : "this teacher"));
    host.appendChild(title);
    host.appendChild(el("p", "field__hint",
      "An override is an exception for this teacher only. A feature that is switched off for the whole " +
      "platform can never be switched on again for one teacher. The review policy is the one exception: " +
      "while the platform has no review policy, a single teacher may have one."));
    const grid = el("div", "admin-grid");
    ADMIN_OVERRIDE_KEYS.forEach(function (entry) {
      const value = adminOverrideValue(teacherId, entry.group, entry.key);
      const select = document.createElement("select");
      select.id = "admin-override-" + entry.group + "-" + entry.key;
      select.setAttribute("data-admin-override", entry.group + ":" + entry.key);
      entry.options.forEach(function (option) {
        const node = document.createElement("option");
        node.value = option[1];
        node.textContent = option[0];
        select.appendChild(node);
      });
      if (value === undefined) {
        select.value = "";
      } else if (entry.group === "pricing") {
        select.value = (value && value.enabled === false) ? '{"enabled":false}' : "";
      } else {
        select.value = String(value);
      }
      grid.appendChild(adminField(entry.label, select));
    });
    host.appendChild(grid);
  }

  /* ====================== ADMIN TEACHER DOC REVIEW ==================== */
  let adminDocReviewOpen = "";
  let adminDocReviewData = null;

  async function loadAdminTeacherDocReview(teacherId) {
    const id = String(teacherId || "");
    if (!id) return;
    try {
      const payload = await apiRequest("/admin/teachers/" + encodeURIComponent(id) + "/documents");
      adminDocReviewData = payload.data || null;
    } catch (error) {
      adminDocReviewData = null;
      adminToast(apiErrorMessage(error));
    }
    renderAdminTeacherDocReview();
  }

  function renderAdminTeacherDocReview() {
    const host = document.getElementById("admin-doc-review-panel");
    if (!host) return;
    host.innerHTML = "";
    const teacherId = String(adminDocReviewOpen || "");
    if (!teacherId || !adminDocReviewData) return;

    const data = adminDocReviewData;
    const teacher = data.teacher || {};
    const card = el("div", "admin-doc-review-card");

    const header = el("div", "panel__head");
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:10px;";

    const titleDiv = el("div");
    titleDiv.appendChild(el("h3", "tp-section__title", "Review Documents for " + (teacher.name || "Teacher #" + teacherId)));
    titleDiv.appendChild(el("p", "field__hint", "Review uploaded government ID and qualification certificate before approving."));
    header.appendChild(titleDiv);

    const statusPill = el("span", "status " + (data.status === "verified" ? "status--accepted" : (data.status === "rejected" ? "status--rejected" : "status--pending")),
      data.status === "verified" ? "Verified ✓" : (data.status === "rejected" ? "Rejected ⚠️" : (data.status === "pending" ? "Pending Review ⏳" : "Not Uploaded")));
    header.appendChild(statusPill);
    card.appendChild(header);

    if (data.rejection_reason) {
      const rejAlert = el("div", "notice notice--error");
      rejAlert.style.cssText = "background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px 14px; margin-bottom:14px; color:#991b1b; font-size:0.88rem;";
      rejAlert.innerHTML = "<strong>Previous Rejection Reason:</strong> " + escapeHtml(data.rejection_reason);
      card.appendChild(rejAlert);
    }

    // Documents list
    const docsList = el("div");
    docsList.style.cssText = "display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; margin-bottom:18px;";

    // ID Document
    const idCard = el("div", "doc-upload-card");
    idCard.style.cssText = "border-style:solid; padding:16px;";
    idCard.appendChild(el("h4", "doc-upload-card__title", "1. Government ID Document"));
    if (data.id_document) {
      const item = el("div", "doc-file-preview");
      item.innerHTML = '<div style="overflow:hidden; text-overflow:ellipsis; max-width:70%;"><strong>' + escapeHtml(data.id_document.name) + '</strong><br><span style="color:var(--ink-500); font-size:0.78rem;">' + escapeHtml(data.id_document.size || "") + '</span></div><a href="' + escapeHtml(data.id_document.url) + '" target="_blank" rel="noopener noreferrer" class="btn btn--light btn--sm" style="padding:4px 10px; font-size:0.8rem;">View / Download</a>';
      idCard.appendChild(item);
    } else {
      idCard.appendChild(el("p", "field__hint", "No government ID uploaded yet."));
    }
    docsList.appendChild(idCard);

    // Qualification Document
    const qualCard = el("div", "doc-upload-card");
    qualCard.style.cssText = "border-style:solid; padding:16px;";
    qualCard.appendChild(el("h4", "doc-upload-card__title", "2. Qualification Certificate"));
    if (data.qualification_document) {
      const item = el("div", "doc-file-preview");
      item.innerHTML = '<div style="overflow:hidden; text-overflow:ellipsis; max-width:70%;"><strong>' + escapeHtml(data.qualification_document.name) + '</strong><br><span style="color:var(--ink-500); font-size:0.78rem;">' + escapeHtml(data.qualification_document.size || "") + '</span></div><a href="' + escapeHtml(data.qualification_document.url) + '" target="_blank" rel="noopener noreferrer" class="btn btn--light btn--sm" style="padding:4px 10px; font-size:0.8rem;">View / Download</a>';
      qualCard.appendChild(item);
    } else {
      qualCard.appendChild(el("p", "field__hint", "No qualification document uploaded yet."));
    }
    docsList.appendChild(qualCard);
    card.appendChild(docsList);

    // Actions
    const acts = el("div");
    acts.style.cssText = "display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap; padding-top:14px; border-top:1px solid var(--line);";

    const hasDocs = data.id_document || data.qualification_document;

    if (hasDocs) {
      const approveBtn = el("button", "btn btn--primary");
      approveBtn.type = "button";
      approveBtn.innerHTML = '<span class="btn__label">✓ Approve Documents</span>';
      approveBtn.addEventListener("click", function () {
        approveBtn.disabled = true;
        apiRequest("/admin/teachers/" + encodeURIComponent(teacherId) + "/verify-documents", {
          method: "POST",
          body: { action: "approve" },
        })
          .then(function () {
            adminToast("Teacher ID & qualification documents approved.");
            return refreshAdminData({ force: true });
          })
          .then(function () {
            return loadAdminTeacherDocReview(teacherId);
          })
          .catch(function (err) {
            adminToast(apiErrorMessage(err));
          })
          .finally(function () {
            approveBtn.disabled = false;
          });
      });
      acts.appendChild(approveBtn);

      const rejectBtn = el("button", "btn btn--danger");
      rejectBtn.type = "button";
      rejectBtn.innerHTML = '<span class="btn__label">Reject Documents</span>';
      rejectBtn.addEventListener("click", function () {
        const reason = window.prompt("Enter rejection reason for the teacher (e.g. 'ID is blurry', 'Certificate not readable'):");
        if (reason === null) return;
        rejectBtn.disabled = true;
        apiRequest("/admin/teachers/" + encodeURIComponent(teacherId) + "/verify-documents", {
          method: "POST",
          body: { action: "reject", reason: reason },
        })
          .then(function () {
            adminToast("Teacher document verification set to rejected.");
            return refreshAdminData({ force: true });
          })
          .then(function () {
            return loadAdminTeacherDocReview(teacherId);
          })
          .catch(function (err) {
            adminToast(apiErrorMessage(err));
          })
          .finally(function () {
            rejectBtn.disabled = false;
          });
      });
      acts.appendChild(rejectBtn);
    }

    const closeBtn = el("button", "btn btn--ghost");
    closeBtn.type = "button";
    closeBtn.innerHTML = '<span class="btn__label">Close Review</span>';
    closeBtn.addEventListener("click", function () {
      adminDocReviewOpen = "";
      renderAdminTeacherDocReview();
    });
    acts.appendChild(closeBtn);

    card.appendChild(acts);
    host.appendChild(card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ============================ ADMIN RENDER ========================== */
  // The dates on which a teacher does not take lessons. They are read from the
  // server, because the booking endpoint refuses a booking on such a date -
  // a list that only lived in the browser would be a list that means nothing.
  let adminUnavailableDates = [];
  let adminUnavailableTeacher = "";
  let adminUnavailableList = null;

  async function loadAdminTeacherUnavailableDates(teacherId) {
    adminUnavailableTeacher = String(teacherId || "");
    adminUnavailableDates = [];
    if (!adminUnavailableTeacher) {
      renderAdminTeacherUnavailableDates();
      return;
    }
    try {
      const payload = await apiRequest(
        "/admin/teachers/" + encodeURIComponent(adminUnavailableTeacher) + "/unavailable-dates"
      );
      adminUnavailableDates = payload.data || [];
    } catch (error) {
      adminUnavailableDates = [];
      adminToast(apiErrorMessage(error));
    }
    renderAdminTeacherUnavailableDates();
  }

  function renderAdminTeacherUnavailableDates() {
    const list = adminUnavailableList;
    if (!list) return;
    list.innerHTML = "";
    if (!adminUnavailableTeacher) {
      list.appendChild(adminEmpty("No teacher chosen", "Choose a teacher to see their unavailable dates."));
      return;
    }
    if (!adminUnavailableDates.length) {
      list.appendChild(adminEmpty("No unavailable dates", "This teacher takes lessons on every date."));
      return;
    }
    adminUnavailableDates.forEach(function (row) {
      const card = el("article", "bkcard");
      card.appendChild(el("h3", "bkcard__teacher", prettyDate(row.date)));
      if (row.reason) card.appendChild(el("p", "bkcard__meta", row.reason));
      const actions = el("div", "bkcard__actions");
      const remove = el("button", "btn btn--ghost");
      remove.type = "button";
      remove.setAttribute("data-admin-remove-unavailable", "1");
      remove.setAttribute("data-date", row.date);
      remove.innerHTML = '<span class="btn__label">Remove date</span>';
      actions.appendChild(remove);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  const ADMIN_RENDERERS = {
    overview: renderAdminOverview, teachers: function () { renderAdminList("teachers", "teacher"); },
    bookings: renderAdminBookings,
    students: function () { renderAdminList("students", "student"); },
    attendance: renderAdminAttendance,
    otp: renderAdminOtp,
    holidays: renderAdminHolidays, eligibility: renderAdminEligibility,
    pricing: renderAdminPricing, terms: renderAdminTerms, contact: renderAdminContact,
    branding: renderAdminBranding, settings: renderAdminSettings,
    moderation: renderAdminModeration, disputes: renderAdminDisputes,
    notifications: renderAdminNotifications,
    roles: renderAdminRoles, audit: renderAdminAudit, data: renderAdminData,
  };

  // Acceptance is recorded only after a real user action (the signup checkbox
  // plus a successful submit). Nothing is ever auto-accepted.
  const termsAcceptance = [];
  function recordTermsAcceptance(userId, role) {
    const doc = platformSettings.terms[role] || platformSettings.terms.common;
    if (!doc) return;
    const already = termsAcceptance.some(function (a) {
      return a.userId === userId && a.role === role && a.version === doc.version;
    });
    if (already) return;
    termsAcceptance.push({ userId: userId, role: role, version: doc.version, at: new Date().toISOString() });
  }
  function acceptedTerms(userId, role) {
    const doc = platformSettings.terms[role] || platformSettings.terms.common;
    if (!doc) return null;
    return termsAcceptance.filter(function (a) {
      return a.userId === userId && a.role === role && a.version === doc.version;
    })[0] || null;
  }
  function init() {
    applyBranding();
    renderContactSections();
    renderTermsLinks();
    if (typeof updateTeacherOtpVisibility === "function") updateTeacherOtpVisibility();
    if (typeof updateStudentOtpVisibility === "function") updateStudentOtpVisibility();
    if (typeof updateForgotPasswordUI === "function") updateForgotPasswordUI();
  }
  function init() {
    wireNotificationCenter("dash");
    wireNotificationCenter("sdash");
    updateNotificationBadges();
    // D9 — the reminder routine no longer runs on page load. It used to create
    // notifications in the browser on every visit, duplicating the server's and
    // disappearing on refresh. Reminders are now produced server-side by
    // POST /api/v1/admin/reminders/run and read back through the notifications API.
  }

  function renderAdmin(focus) {
    adminSection = adminSectionFromHash();
    adminView.querySelectorAll("[data-anav]").forEach(function (btn) {
      const key = btn.getAttribute("data-anav");
      const active = key === adminSection;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    adminView.querySelectorAll("[data-apanel]").forEach(function (p) {
      p.hidden = p.getAttribute("data-apanel") !== adminSection;
    });
    const title = document.getElementById("admin-" + adminSection + "-title");
    if (title) title.textContent = ADMIN_SECTION_TITLES[adminSection];
    const sub = document.getElementById("admin-" + adminSection + "-sub");
    if (sub) sub.textContent = ADMIN_SUBTITLES[adminSection] || "";
    adminWelcome.textContent = ADMIN_SECTION_TITLES[adminSection];
    adminRoleChip.textContent = adminSession.role === "super-admin" ? "Super Admin" : "Admin";
    var dataNav = adminView.querySelector('[data-anav="data"]');
    if (dataNav) dataNav.hidden = adminSession.role !== "super-admin";
    const renderer = ADMIN_RENDERERS[adminSection];
    if (renderer) renderer();
    applyBranding();
    setAdminNav(false);
    if (focus !== false && title) {
      if (!title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1");
      title.focus({ preventScroll: true });
    }
  }

  const ADMIN_SUBTITLES = {
    overview: "Platform counts drawn from the records returned by the admin API.",
    teachers: "Search, review and manage teacher accounts.", students: "Search and manage student accounts.",
    attendance: "Choose how attendance is verified and configure WhatsApp OTP.",
    notifications: "Control which notifications are sent and when attendance reminders run.",
    holidays: "Platform-wide holidays and teacher-specific unavailable dates.",
    eligibility: "Set the conditions a student must meet before writing a review.",
    pricing: "Control which pricing types teachers may offer.",
    terms: "Draft, preview and publish terms and conditions.",
    contact: "Configure the support details shown to students and teachers.",
    branding: "Name, logos and favicon applied across the application.",
    settings: "Platform-wide defaults.", moderation: "Reviews submitted by students.",
    disputes: "Attendance disputes and correction requests awaiting a decision.",
    roles: "Admin and Super Admin responsibilities.", audit: "Every administrative change, with old and new values.",
    data: "Database status, read-only table inspection and backup management. Super Admin only.",
  };

  function handleTermsBack() {
    navigate(termsReturnView || "login");
  }
  const termsViewBack = document.getElementById("terms-view-back");
  if (termsViewBack) termsViewBack.addEventListener("click", handleTermsBack);
  const termsViewTopBack = document.getElementById("terms-view-top-back");
  if (termsViewTopBack) termsViewTopBack.addEventListener("click", handleTermsBack);

  // The pricing form lives in the TEACHER dashboard, so its save action needs
  // its own listener — the admin view's delegated handler never sees it.
  if (dashboardView) {
    dashboardView.addEventListener("click", function (event) {
      if (event.target.closest("[data-save-prices]")) savePrices();
    });
  }

  adminMenu.addEventListener("click", function () { setAdminNav(!adminNavOpen); });
  adminScrim.addEventListener("click", function () { setAdminNav(false); });
  adminView.querySelectorAll("[data-anav]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const key = btn.getAttribute("data-anav");
      setAdminNav(false);
      if (key === "logout") { logoutSession("login"); return; }
      showAdminSection(key);
    });
  });


  
  function adminToast(msg) { showToast(msg); }
  function readToggle(id) { const e = document.getElementById(id); return e ? e.checked : false; }
  function readVal(id) { const e = document.getElementById(id); return e ? e.value : ""; }
  function readNum(id) { const e = document.getElementById(id); return e ? Number(e.value) : NaN; }
  function readSel(id) { return readVal(id); }

  // Delegated clicks so re-rendered panels keep working without re-binding.
  adminView.addEventListener("click", function (event) {
    const t = event.target;
    let el;

    el = t.closest("[data-admin-refresh]");
    if (el) {
      refreshAdminData({ force: true });
      return;
    }

    el = t.closest("[data-account-toggle]");
    if (el) {
      const parts = el.getAttribute("data-account-toggle").split(":");
      const kind = parts[0], id = parts[1];
      const st = accountState(kind, id);
      const next = st.status === "suspended" ? "active" : "suspended";
      if (next === "suspended" && !window.confirm("Suspend this account? Its bookings, reviews and attendance are kept.")) return;
      el.disabled = true;
      apiRequest("/admin/users/" + encodeURIComponent(id) + "/status", {
        method: "PATCH",
        body: { status: next },
      })
        .then(function () {
          auditAdmin(kind + " account", id, next === "suspended" ? "active" : "suspended", next,
            next === "suspended" ? "Account suspended by admin" : "Account reactivated");
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast(next === "suspended" ? "Account suspended. Records preserved." : "Account reactivated.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-account-close]");
    if (el) {
      const id = el.getAttribute("data-account-close").split(":")[1];
      const reason = window.prompt(
        "Close this account?\n\n" +
        "The personal details are anonymised and the account can never sign in again. " +
        "Bookings, attendance, reviews and terms acceptances are kept for the record.\n\n" +
        "Optional reason for the audit trail:"
      );
      if (reason === null) return;
      el.disabled = true;
      apiRequest("/admin/users/" + encodeURIComponent(id) + "/account", {
        method: "DELETE",
        body: { reason: reason },
      })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Account closed and anonymised. Records preserved.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-approve-toggle]");
    if (el) {
      const id = el.getAttribute("data-approve-toggle");
      const st = accountState("teacher", id);
      const next = !st.approved;
      el.disabled = true;
      apiRequest("/admin/teachers/" + encodeURIComponent(id) + "/approval", {
        method: "PATCH",
        body: { approved: next },
      })
        .then(function () {
          auditAdmin("teacher account", id + " approval", String(!next), String(next));
          return loadAdminState().then(function () {
            renderAdmin(false);
            // A newly approved profile should appear in the public directory.
            return loadPublicTeachers().catch(function () {});
          });
        })
        .then(function () {
          adminToast(next ? "Teacher profile approved." : "Teacher approval revoked.");
          renderAdmin(false);
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-save-attendance]");
    if (el) {
      const before = JSON.stringify(platformSettings.attendance);
      // Only the settings that are genuinely configurable are sent. The
      // fixed rules (a missing response stays pending, a conflicting response
      // becomes a dispute that only an administrator can decide) are not
      // settings, and the attendance OTP options are gone for good.
      const next = {
        verificationEnabled: readToggle("admin-att-enabled"),
        verificationMethod: readSel("admin-att-method"),
        requireReasonWhenLessonMissed: readToggle("admin-att-reason"),
      };
      auditAdmin("Attendance settings", "method", JSON.parse(before).method, next.verificationMethod,
        "Verification method changed");
      el.disabled = true;
      saveSettingsGroups({ attendance: next })
        .then(function () {
          renderAdmin(false);
          adminToast("Attendance settings saved. Existing records are untouched.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-wa-send]");
    if (el) {
      const to = readVal("admin-wa-test-to");
      if (!to || normalizeWhatsapp(to).length < 8) {
        adminToast("Enter a valid test recipient number including the country code.");
        return;
      }
      el.disabled = true;
      apiRequest("/admin/whatsapp/test", { method: "POST", body: { recipient: normalizeWhatsapp(to) } })
        .then(function (payload) {
          const result = (payload && payload.data) || {};
          if (result.code) {
            adminToast("Test code generated: " + result.code + (result.delivered ? " (Delivered to provider)" : " (Provider not configured — unverified delivery)"));
          } else if (result.delivered) {
            adminToast("Test message accepted by the provider.");
          } else {
            adminToast("A test code was generated, but no message was delivered: " +
              (result.reason || "the provider is not configured.") +
              " No delivery is claimed.");
          }
          // The server records the outcome of the attempt, so the panel is
          // re-read instead of the browser writing a value of its own.
          return loadAdminState().then(function () {
            renderAdmin(false);
          });
        })
        .catch(function (error) {
          adminToast(apiErrorMessage(error));
          return loadAdminState().then(function () {
            renderAdmin(false);
          });
        })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-save-otp]");
    if (el) {
      const w = platformSettings.whatsapp || {};
      const o = platformSettings.otp || {};
      const expiry = Math.max(1, Math.min(60, parseInt(readVal("admin-otp-expiry") || "10", 10)));
      const attempts = Math.max(1, Math.min(10, parseInt(readVal("admin-otp-attempts") || "5", 10)));
      const nextOtp = {
        enabled: readToggle("admin-otp-enabled"),
        requireRegistrationOtp: readToggle("admin-otp-reg"),
        requirePasswordResetOtp: readToggle("admin-otp-pass"),
        channel: "whatsapp",
        otpExpiryMinutes: expiry,
        otpMaxAttempts: attempts,
      };
      const nextWa = {
        enabled: readToggle("admin-wa-enabled"),
        provider: w.provider || "meta-cloud-api",
        phoneNumberId: readVal("admin-wa-phone-id").trim(),
        businessAccountId: readVal("admin-wa-waba-id").trim(),
        testRecipient: readVal("admin-wa-test-to").trim(),
        otpExpiryMinutes: expiry,
        otpMaxAttempts: attempts,
        credentialSource: w.credentialSource || "server-environment",
        lastTestStatus: w.lastTestStatus || "not-configured",
      };
      el.disabled = true;
      saveSettingsGroups({ otp: nextOtp, whatsapp: nextWa })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("OTP & WhatsApp settings saved successfully.");
          });
        })
        .catch(function (error) {
          adminToast(apiErrorMessage(error) || "Could not save OTP settings.");
        })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-save-whatsapp]");
    if (el) {
      const w = platformSettings.whatsapp;
      const before = w.testRecipient;
      const next = {
        enabled: readToggle("admin-wa-enabled"),
        provider: w.provider || "meta-cloud-api",
        phoneNumberId: readVal("admin-wa-phone-id").trim(),
        businessAccountId: readVal("admin-wa-waba-id").trim(),
        testRecipient: readVal("admin-wa-test-to").trim(),
        otpExpiryMinutes: Number(w.otpExpiryMinutes || 10),
        otpMaxAttempts: Number(w.otpMaxAttempts || 5),
        credentialSource: w.credentialSource || "server-environment",
        // The result of the last test is written by the server.
        lastTestStatus: w.lastTestStatus || "not-configured",
      };
      auditAdmin("WhatsApp integration", "testRecipient", before, next.testRecipient);
      el.disabled = true;
      saveSettingsGroups({ whatsapp: next })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("WhatsApp settings saved. The access token stays server-side.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-create-user]");
    if (el) {
      const name = readVal("admin-create-name").trim();
      const email = readVal("admin-create-email").trim();
      const password = readVal("admin-create-password");
      const role = readSel("admin-create-role");
      if (!name) { adminToast("Give the account a name."); return; }
      if (!email) { adminToast("Give the account an email address."); return; }
      if (!password) { adminToast("Give the account a password."); return; }
      el.disabled = true;
      apiRequest("/admin/users", {
        method: "POST",
        body: { name: name, email: email, password: password, role: role },
      })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("The account was created.");
          });
        })
        .catch(function (error) {
          const errors = apiFieldErrors(error);
          const first = Object.keys(errors)[0];
          adminToast(first ? String(errors[first][0]) : apiErrorMessage(error));
        })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-teacher-overrides]");
    if (el) {
      const teacherId = el.getAttribute("data-admin-teacher-overrides");
      adminOverridesOpen = String(adminOverridesOpen) === String(teacherId) ? "" : String(teacherId);
      if (adminOverridesOpen) {
        loadAdminTeacherOverrides(adminOverridesOpen);
      } else {
        renderAdminTeacherOverrides();
      }
      return;
    }

    el = t.closest("[data-admin-review-docs]");
    if (el) {
      const teacherId = el.getAttribute("data-admin-review-docs");
      adminDocReviewOpen = String(adminDocReviewOpen) === String(teacherId) ? "" : String(teacherId);
      if (adminDocReviewOpen) {
        loadAdminTeacherDocReview(adminDocReviewOpen);
      } else {
        renderAdminTeacherDocReview();
      }
      return;
    }

    el = t.closest("[data-admin-bookings-prev]");
    if (el) {
      if (adminBookingsPage <= 1) return;
      refreshAdminBookings({ page: adminBookingsPage - 1 });
      return;
    }

    el = t.closest("[data-admin-bookings-next]");
    if (el) {
      if (adminBookingsPage >= adminBookingsPages) return;
      refreshAdminBookings({ page: adminBookingsPage + 1 });
      return;
    }

    el = t.closest("[data-admin-approve-booking]");
    if (el) {
      const id = el.getAttribute("data-admin-approve-booking");
      const booking = apiAdminBookings.find(function (b) { return String(b.id) === String(id); });
      if (booking) openAdminBookingApprovalModal(booking);
      return;
    }

    el = t.closest("[data-admin-edit-fee]");
    if (el) {
      const id = el.getAttribute("data-admin-edit-fee");
      const booking = apiAdminBookings.find(function (b) { return String(b.id) === String(id); });
      if (booking) openAdminBookingFeeModal(booking);
      return;
    }

    el = t.closest("[data-admin-cancel-booking]");
    if (el) {
      const id = el.getAttribute("data-id");
      if (!id) return;
      if (!window.confirm("Cancel this booking? The lesson stays on record and both sides are told.")) return;
      el.disabled = true;
      apiRequest("/bookings/" + encodeURIComponent(id) + "/cancel", { method: "PATCH" })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("The booking was cancelled. The lesson and its records were kept.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-add-unavailable]");
    if (el) {
      const date = readVal("admin-teacher-unavailable-date");
      const reason = readVal("admin-teacher-unavailable-reason").trim();
      if (!adminUnavailableTeacher) { adminToast("Choose a teacher first."); return; }
      if (!date) { adminToast("Choose the date the teacher is unavailable."); return; }
      el.disabled = true;
      apiRequest("/admin/teachers/" + encodeURIComponent(adminUnavailableTeacher) + "/unavailable-dates", {
        method: "POST",
        body: { date: date, reason: reason || null },
      })
        .then(function () {
          return loadAdminTeacherUnavailableDates(adminUnavailableTeacher).then(function () {
            adminToast("The date was added. New bookings on it are refused.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-remove-unavailable]");
    if (el) {
      const date = el.getAttribute("data-date");
      if (!date || !adminUnavailableTeacher) return;
      el.disabled = true;
      apiRequest(
        "/admin/teachers/" + encodeURIComponent(adminUnavailableTeacher) + "/unavailable-dates/" + encodeURIComponent(date),
        { method: "DELETE" }
      )
        .then(function () {
          return loadAdminTeacherUnavailableDates(adminUnavailableTeacher).then(function () {
            adminToast("The unavailable date was removed.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-audit-clear]") || t.closest("[data-admin-audit-reset-filters]");
    if (el) {
      adminAuditFilters.action = "";
      adminAuditFilters.actor_id = "";
      adminAuditFilters.search = "";
      adminAuditPage = 1;
      refreshAdminAudit().then(function () {
        renderAdmin(false);
        adminToast("The audit filters were cleared.");
      });
      return;
    }

    el = t.closest("[data-admin-audit-clear-logs]");
    if (el) {
      if (!window.confirm("Are you sure you want to clear all administrative activity logs? This action cannot be undone.")) {
        return;
      }
      el.disabled = true;
      apiRequest("/admin/audit-logs", { method: "DELETE" })
        .then(function (payload) {
          replaceArray(adminAudit, []);
          adminAuditTotal = 0;
          renderAdmin(false);
          adminToast((payload && payload.message) || "Activity logs cleared.");
        })
        .catch(function (error) {
          adminToast(apiErrorMessage(error));
        })
        .finally(function () {
          el.disabled = false;
        });
      return;
    }

    el = t.closest("[data-admin-audit-more]");
    if (el) {
      el.disabled = true;
      refreshAdminAudit(adminAuditPage + 1).then(function () {
        el.disabled = false;
      });
      return;
    }

    el = t.closest("[data-admin-holiday-add]");
    if (el) {
      const date = readVal("admin-holiday-date");
      const label = readVal("admin-holiday-label").trim();
      if (!date) { adminToast("Choose a holiday date first."); return; }
      if (!label) { adminToast("Give the holiday a label."); return; }
      if (platformSettings.holidays.platform.some(function (h) { return h.date === date; })) {
        adminToast("That date is already a platform holiday."); return;
      }
      el.disabled = true;
      apiRequest("/admin/holidays", { method: "POST", body: { date: date, label: label } })
        .then(function () {
          auditAdmin("Platform holidays", "add", "", date + " " + label);
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Holiday added. Existing bookings were not changed.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-holiday-remove]");
    if (el) {
      const id = el.getAttribute("data-admin-holiday-remove");
      const holiday = platformSettings.holidays.platform.filter(function (h) {
        return String(h.id || h.date) === String(id);
      })[0];
      if (!window.confirm("Remove this platform holiday? Existing bookings are not changed.")) return;
      el.disabled = true;
      apiRequest("/admin/holidays/" + encodeURIComponent(id), { method: "DELETE" })
        .then(function () {
          auditAdmin("Platform holidays", "remove", holiday ? holiday.date : id, "");
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Holiday removed.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-save-holidays]");
    if (el) {
      // The holiday rows are owned by the holidays endpoint. Only the switch
      // that decides whether a holiday blocks new bookings is a setting.
      const next = { blockNewBookings: readToggle("admin-holiday-block") };
      auditAdmin("Holiday settings", "blockNewBookings", "", String(next.blockNewBookings));
      saveSettingsGroups({ holidays: next })
        .then(function () {
          renderAdmin(false);
          adminToast("Holiday settings saved. Existing bookings are never changed.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); });
      return;
    }

    el = t.closest("[data-admin-save-eligibility]");
    if (el) {
      const before = JSON.stringify(platformSettings.eligibility);
      const next = {
        configured: readToggle("admin-el-configured"),
        type: readSel("admin-el-type"),
        minConfirmedDays: readNum("admin-el-days"),
        minCompletedLessons: readNum("admin-el-lessons"),
        requireCompletedBooking: readToggle("admin-el-booking"),
      };
      if (next.configured && next.type === "study-days" && !(next.minConfirmedDays >= 1)) {
        adminToast("A study-days policy needs a minimum of at least 1 day.");
        return;
      }
      auditAdmin("Review eligibility", "policy", JSON.parse(before).type, next.type);
      auditAdmin("Review eligibility", "minimum", JSON.parse(before).minConfirmedDays, next.minConfirmedDays);
      saveSettingsGroups({ eligibility: next })
        .then(function () {
          renderAdmin(false);
          adminToast("Eligibility settings saved. Existing reviews were not changed.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); });
      return;
    }

    el = t.closest("[data-admin-save-pricing]");
    if (el) {
      const next = {};
      ["hourly", "monthly", "course"].forEach(function (k) {
        const before = JSON.stringify(platformSettings.pricing[k]);
        const value = {
          enabled: readToggle("admin-price-" + k + "-enabled"),
          mode: readSel("admin-price-" + k + "-mode"),
        };
        next[k] = value;
        if (before !== JSON.stringify(value)) {
          auditAdmin("Pricing", k, JSON.parse(before).enabled + "/" + JSON.parse(before).mode,
            value.enabled + "/" + value.mode);
        }
      });
      saveSettingsGroups({ pricing: next })
        .then(function () {
          renderAdmin(false);
          adminToast("Pricing settings saved.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); });
      return;
    }

    el = t.closest("[data-admin-save-contact]");
    if (el) {
      const c = platformSettings.contact;
      const email = readVal("admin-contact-email");
      const phone = readVal("admin-contact-phone");
      if (email && !validEmail(email)) { adminToast("That support email is not valid."); return; }
      if (phone && !validPhone(phone)) { adminToast("That support phone number is not valid."); return; }
      const before = JSON.stringify(c);
      const next = {
        enabled: readToggle("admin-contact-enabled"),
        title: readVal("admin-contact-title-field").trim(),
        message: readVal("admin-contact-message").trim(),
        email: email.trim(),
        phone: phone.trim(),
        whatsapp: readVal("admin-contact-whatsapp").trim(),
        hours: readVal("admin-contact-hours").trim(),
        showEmail: readToggle("admin-contact-show-email"),
        showPhone: readToggle("admin-contact-show-phone"),
        showWhatsapp: readToggle("admin-contact-show-whatsapp"),
      };
      el.disabled = true;
      saveSettingsGroups({ contact: next })
        .then(function () {
          auditAdmin("Contact settings", "section", before, JSON.stringify(next));
          renderAdmin(false);
          renderContactSections();
          adminToast("Contact settings saved.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-save-general]");
    if (el) {
      const g = platformSettings.general;
      const before = g.appName;
      const next = {
        appName: readVal("admin-gen-name"),
        supportSignup: readToggle("admin-gen-signup"),
        teacherSignup: readToggle("admin-gen-teachersignup"),
        newBookingsAccepted: readToggle("admin-gen-bookings"),
        teacherApprovalRequired: readToggle("admin-gen-approval"),
        requireTeacherDocumentVerification: readToggle("admin-gen-require-docs"),
        maintenanceMode: readToggle("admin-gen-maintenance"),
        maintenanceNotice: readVal("admin-gen-maintenance-notice").trim()
          || "The platform is temporarily unavailable for maintenance. Please check back shortly.",
      };
      auditAdmin("General settings", "appName", before, next.appName);
      el.disabled = true;
      saveSettingsGroups({ general: next })
        .then(function () {
          if (next.appName) {
            platformSettings.branding = platformSettings.branding || {};
            platformSettings.branding.appName = next.appName;
            platformSettings.general.appName = next.appName;
            applyBranding();
          }
          renderAdmin(false);
          adminToast("General settings saved.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-folder-choose]");
    if (el) {
      loadAdminDataFolders(adminBackupRoot, adminBackupDirectory);
      return;
    }

    el = t.closest("[data-admin-folder-open]");
    if (el) {
      loadAdminDataFolders(adminBackupRoot, el.getAttribute("data-admin-folder-open") || "");
      return;
    }

    el = t.closest("[data-admin-folder-up]");
    if (el) {
      if (adminDataFolderBrowse && adminDataFolderBrowse.parent) {
        loadAdminDataFolders(adminBackupRoot, adminDataFolderBrowse.parent);
      }
      return;
    }

    el = t.closest("[data-admin-folder-select]");
    if (el) {
      if (adminDataFolderBrowse) selectAdminBackupFolder(adminDataFolderBrowse.path);
      return;
    }

    el = t.closest("[data-admin-folder-cancel]");
    if (el) {
      closeAdminFolderBrowser();
      return;
    }

    el = t.closest("[data-admin-folder-create]");
    if (el) {
      var folderNameInput = document.querySelector("[data-admin-folder-name]");
      var folderName = folderNameInput ? folderNameInput.value.trim() : "";

      if (!folderName) {
        adminToast("Enter a name for the new folder.");
        return;
      }

      var folderParent = adminDataFolderBrowse ? adminDataFolderBrowse.path : adminBackupDirectory;
      el.disabled = true;
      apiRequest("/admin/data/folders", {
        method: "POST",
        body: { root: adminBackupRoot, parent: folderParent, name: folderName },
      })
        .then(function () {
          adminToast("Folder created.");
          return loadAdminDataFolders(adminBackupRoot, folderParent);
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-backup-download]");
    if (el) {
      downloadAdminBackup();
      return;
    }

    el = t.closest("[data-admin-restore-start]");
    if (el) {
      startAdminRestore();
      return;
    }

    el = t.closest("[data-admin-save-backups]");
    if (el) {
      var backupSettings = {
        root: adminBackupRoot,
        directory: (adminBackupDirectory || "").trim(),
        retainDays: readNum("admin-backup-retain"),
        scheduleEnabled: readToggle("admin-backup-schedule"),
        scheduleTime: readVal("admin-backup-time").trim(),
      };

      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupSettings.scheduleTime)) {
        adminToast("Use a 24-hour time such as 02:00.");
        return;
      }
      if (!(backupSettings.retainDays >= 1 && backupSettings.retainDays <= 365)) {
        adminToast("Keep backups for between 1 and 365 days.");
        return;
      }

      el.disabled = true;
      saveSettingsGroups({ backups: backupSettings })
        .then(function () { return loadAdminState(); })
        .then(function () {
          renderAdmin(false);
          adminToast("Backup settings saved.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-backup-now]");
    if (el) {
      el.disabled = true;
      apiRequest("/admin/data/backups", { method: "POST" })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Backup created.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-backup-delete]");
    if (el) {
      var backupName = el.getAttribute("data-admin-backup-delete");
      if (!window.confirm("Delete the backup " + backupName + "?")) return;
      el.disabled = true;
      apiRequest("/admin/data/backups/" + encodeURIComponent(backupName), { method: "DELETE" })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Backup deleted.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-storage-activate]");
    if (el) {
      var pKey = el.getAttribute("data-storage-activate");
      el.disabled = true;
      apiRequest("/admin/storage/providers/" + encodeURIComponent(pKey) + "/activate", { method: "POST" })
        .then(function (res) {
          adminToast(res.message || "Active storage provider changed.");
          return loadAdminStorageState(true);
        })
        .catch(function (err) { adminToast(apiErrorMessage(err)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-storage-test]");
    if (el) {
      var pKey = el.getAttribute("data-storage-test");
      el.disabled = true;
      var origLabel = el.innerHTML;
      el.innerHTML = '<span class="btn__label">Testing...</span>';
      apiRequest("/admin/storage/providers/" + encodeURIComponent(pKey) + "/test", { method: "POST" })
        .then(function (res) {
          adminToast((res.data && res.data.message) ? res.data.message : "Connection test passed.");
          return loadAdminStorageState(true);
        })
        .catch(function (err) {
          adminToast(apiErrorMessage(err));
          return loadAdminStorageState(true);
        })
        .finally(function () {
          el.disabled = false;
          el.innerHTML = origLabel;
        });
      return;
    }

    el = t.closest("[data-storage-configure]");
    if (el) {
      var pKey = el.getAttribute("data-storage-configure");
      openStorageConfigModal(pKey);
      return;
    }

    el = t.closest("[data-storage-disconnect]");
    if (el) {
      var pKey = el.getAttribute("data-storage-disconnect");
      if (!window.confirm("Disconnect " + pKey + " and remove its stored credentials?")) return;
      el.disabled = true;
      apiRequest("/admin/storage/providers/" + encodeURIComponent(pKey) + "/disconnect", { method: "POST" })
        .then(function (res) {
          adminToast(res.message || "Provider disconnected.");
          return loadAdminStorageState(true);
        })
        .catch(function (err) { adminToast(apiErrorMessage(err)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-storage-open-logs]");
    if (el) {
      openStorageLogsModal();
      return;
    }

    el = t.closest("[data-admin-data-load]");
    if (el) {
      loadAdminDataRows(readVal("admin-data-table"), 1);
      return;
    }

    el = t.closest("[data-admin-data-page]");
    if (el) {
      loadAdminDataRows(readVal("admin-data-table") || adminDataTable,
        Number(el.getAttribute("data-admin-data-page")));
      return;
    }

    el = t.closest("[data-admin-save-branding]");
    if (el) {
      const b = platformSettings.branding;
      const before = JSON.stringify({ n: b.appName, t: b.tagline });
      const name = readVal("admin-brand-appname").trim();
      if (!name) { adminToast("The app name cannot be empty."); return; }
      const next = {
        appName: name,
        tagline: readVal("admin-brand-tagline").trim(),
        logo: b.logo === undefined ? null : b.logo,
        logo2: b.logo2 === undefined ? null : b.logo2,
        favicon: b.favicon === undefined ? null : b.favicon,
      };
      auditAdmin("Branding", "appName/tagline", before, JSON.stringify({ n: next.appName, t: next.tagline }));
      platformSettings.branding = Object.assign({}, platformSettings.branding, next);
      platformSettings.general = platformSettings.general || {};
      platformSettings.general.appName = next.appName;
      applyBranding();
      el.disabled = true;
      saveSettingsGroups({ branding: next })
        .then(uploadPendingBrandFiles)
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Branding published across the application.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-brand-reset]");
    if (el) {
      const key = el.getAttribute("data-admin-brand-reset");
      if (!window.confirm("Reset this image to the default? Other branding settings are untouched.")) return;
      el.disabled = true;
      apiRequest("/admin/branding/reset", { method: "POST", body: { slot: key } })
        .then(function () {
          delete pendingBrandFiles[key];
          platformSettings.branding[key] = null;
          auditAdmin("Branding", key, "custom", "default");
          applyBranding();
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Reset to the default mark.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-terms-add]");
    if (el) {
      const name = window.prompt("Enter a title for the new policy (e.g. Refund Policy, Cancellation Policy, Honor Code):");
      if (!name || !name.trim()) return;
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").substring(0, 40);
      if (!slug) { adminToast("Please enter a valid policy name."); return; }
      if (!customTermsPolicies.includes(slug)) {
        customTermsPolicies.push(slug);
        try { localStorage.setItem("app_custom_policies", JSON.stringify(customTermsPolicies)); } catch (e) {}
      }
      platformSettings.terms["draft-" + slug] = {
        title: name.trim(),
        body: "",
      };
      renderAdmin(false);
      adminToast("New policy section '" + name.trim() + "' added. You can now draft and publish it.");
      return;
    }

    el = t.closest("[data-admin-terms-remove-custom]");
    if (el) {
      const role = el.getAttribute("data-admin-terms-remove-custom");
      if (!window.confirm("Remove this policy section?")) return;
      const idx = customTermsPolicies.indexOf(role);
      if (idx !== -1) {
        customTermsPolicies.splice(idx, 1);
        try { localStorage.setItem("app_custom_policies", JSON.stringify(customTermsPolicies)); } catch (e) {}
      }
      platformSettings.terms[role] = null;
      delete platformSettings.terms["draft-" + role];
      apiRequest("/admin/terms/" + encodeURIComponent(role), { method: "DELETE" }).catch(function () {});
      renderAdmin(false);
      adminToast("Policy section removed.");
      return;
    }

    el = t.closest("[data-admin-terms-draft]");
    if (el) {
      const role = el.getAttribute("data-admin-terms-draft");
      platformSettings.terms["draft-" + role] = {
        title: readVal("admin-terms-" + role + "-title"),
        body: readVal("admin-terms-" + role + "-body"),
      };
      renderAdmin(false);
      adminToast("Draft saved. The published version is unchanged.");
      return;
    }

    el = t.closest("[data-admin-terms-clear-draft]");
    if (el) {
      const role = el.getAttribute("data-admin-terms-clear-draft");
      delete platformSettings.terms["draft-" + role];
      renderAdmin(false);
      adminToast("Draft cleared.");
      return;
    }

    el = t.closest("[data-admin-terms-delete]");
    if (el) {
      const role = el.getAttribute("data-admin-terms-delete");
      const label = roleTermsDefaultTitle(role);
      if (!window.confirm("Are you sure you want to delete the published terms for " + label + "? This will revert it to 'Nothing published yet'.")) {
        return;
      }
      el.disabled = true;
      apiRequest("/admin/terms/" + encodeURIComponent(role), { method: "DELETE" })
        .then(function (payload) {
          platformSettings.terms[role] = null;
          delete platformSettings.terms["draft-" + role];
          return loadAdminState().then(function () {
            renderAdmin(false);
            renderTermsLinks();
            adminToast((payload && payload.message) || "Terms deleted for " + label + ".");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-terms-preview]");
    if (el) {
      const role = el.getAttribute("data-admin-terms-preview");
      const box = document.getElementById("admin-terms-" + role + "-preview");
      if (box) {
        const draft = platformSettings.terms["draft-" + role];
        const title = draft ? draft.title : readVal("admin-terms-" + role + "-title");
        const body = draft ? draft.body : readVal("admin-terms-" + role + "-body");
        box.innerHTML = renderTermsBody(title, body);
      }
      adminToast("Preview only — nothing has been published.");
      return;
    }

    el = t.closest("[data-admin-terms-publish]");
    if (el) {
      const role = el.getAttribute("data-admin-terms-publish");
      const draft = platformSettings.terms["draft-" + role];
      const title = draft ? draft.title : readVal("admin-terms-" + role + "-title");
      const body = draft ? draft.body : readVal("admin-terms-" + role + "-body");
      const displayTitle = (title && title.trim()) || roleTermsDefaultTitle(role);
      const msg = !body.trim()
        ? "Publish " + displayTitle + " with an empty body? This will clear all clauses for this policy."
        : "Publish a new version of " + displayTitle + "? The previous published version is kept in history.";
      if (!window.confirm(msg)) return;
      el.disabled = true;
      publishTerms(role, (title || "").trim(), body || "")
        .then(function (document) {
          delete platformSettings.terms["draft-" + role];
          renderAdmin(false);
          renderTermsLinks();
          adminToast("Published as version " + ((document && document.version) || "new") + ".");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-role-save]");
    if (el) {
      const userId = el.getAttribute("data-admin-role-save");
      const select = document.getElementById("admin-role-select-" + userId);
      const role = select ? select.value : "";
      if (!role) { adminToast("Choose a role first."); return; }
      if (!window.confirm("Change this account's role? Administrator access is granted immediately.")) return;
      el.disabled = true;
      apiRequest("/admin/users/" + encodeURIComponent(userId) + "/role", {
        method: "PATCH",
        body: { role: role },
      })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Role updated. The server applied the new permissions.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-review-status]");
    if (el) {
      const parts = el.getAttribute("data-admin-review-status").split(":");
      const reviewId = parts[0];
      const status = parts[1];
      const note = readVal("admin-review-note-" + reviewId).trim();
      if (!["published", "hidden", "flagged"].includes(status)) return;
      el.disabled = true;
      apiRequest("/admin/reviews/" + encodeURIComponent(reviewId) + "/moderation", {
        method: "PATCH",
        body: { status: status, note: note || null },
      })
        .then(function () {
          return loadAdminState().then(function () {
            renderAdmin(false);
            adminToast("Review " + (REVIEW_STATUS_LABELS[status] || status).toLowerCase() + ".");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-open-console]");
    if (el) { navigate("adminReview"); return; }

    el = t.closest("[data-admin-save-notifications]");
    if (el) {
      const n = notifSettings();
      const before = JSON.stringify(n);
      const next = {
        enabled: Object.assign({}, n.enabled),
        reminderDelayHours: readNum("admin-notif-delay"),
        reminderIntervalHours: readNum("admin-notif-interval"),
        maxReminderAttempts: readNum("admin-notif-max"),
        // The two dispute switches are independent of the general per-category
        // switches: a message is only sent when both allow it.
        notifyAdminsOnDispute: readToggle("admin-notif-admins"),
        notifyPartiesOnResolution: readToggle("admin-notif-resolve"),
      };
      Object.keys(NOTIFICATION_CATEGORIES).forEach(function (cat) {
        next.enabled[cat] = readToggle("admin-notif-" + cat);
      });
      const bad =
        !(next.reminderDelayHours >= 0) || next.reminderDelayHours > 168 ||
        !(next.reminderIntervalHours >= 1) || next.reminderIntervalHours > 168 ||
        !(next.maxReminderAttempts >= 1) || next.maxReminderAttempts > 10;
      if (bad) {
        renderAdmin(false);
        adminToast("Reminder timing must be whole numbers: delay 0-168 hours, interval 1-168, maximum 1-10. The previous values were kept.");
        return;
      }
      el.disabled = true;
      saveSettingsGroups({ notifications: next })
        .then(function () {
          auditAdmin("Notification settings", "reminders",
            JSON.parse(before).reminderDelayHours + "h/" + JSON.parse(before).reminderIntervalHours + "h/" + JSON.parse(before).maxReminderAttempts,
            next.reminderDelayHours + "h/" + next.reminderIntervalHours + "h/" + next.maxReminderAttempts);
          renderAdmin(false);
          adminToast("Notification settings saved. Existing notifications were kept.");
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .finally(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-admin-run-reminders]");
    if (el) {
      // D7 — the reminder routine now runs on the server. Previously this called
      // a browser-only runner and reported a count that was never persisted. The
      // server deduplicates per record, so repeat clicks create nothing new, and
      // the toast reports the count the server actually created.
      el.disabled = true;
      apiRequest("/admin/reminders/run", { method: "POST" })
        .then(function (payload) {
          const result = (payload && payload.data) || {};
          return loadNotifications().then(function () {
            renderAdmin(false);
            if (result.reason === "category-disabled") {
              adminToast("Attendance reminders are switched off in notification settings.");
            } else if (result.created > 0) {
              adminToast(result.created + " reminder" + (result.created === 1 ? "" : "s") +
                " created. Attendance was not confirmed.");
            } else {
              adminToast("No reminders are due right now. Nothing was duplicated.");
            }
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); })
        .then(function () { el.disabled = false; });
      return;
    }

    el = t.closest("[data-save-prices]");
    if (el) { savePrices(); return; }

    el = t.closest("[data-admin-cancel]");
    if (el) { renderAdmin(false); adminToast("Changes discarded — nothing was saved."); return; }
  });

  // Search + status filters re-render their list as you type.
  adminView.addEventListener("input", function (event) {
    const t = event.target;
    if (t.id === "admin-teachers-search") { adminSearch.teacher = t.value; renderAdminList("teachers", "teacher"); }
    if (t.id === "admin-students-search") { adminSearch.student = t.value; renderAdminList("students", "student"); }
    if (t.id === "admin-overview-audit-search" || t.id === "admin-audit-search") {
      adminAuditFilters.search = t.value.trim();
      if (adminAuditSearchTimer) clearTimeout(adminAuditSearchTimer);
      adminAuditSearchTimer = setTimeout(function () {
        adminAuditSearchTimer = null;
        adminAuditPage = 1;
        refreshAdminAudit(1);
      }, 300);
    }
    if (t.id === "admin-bookings-search") {
      // The booking list is read from the server, so the search waits for a
      // short pause instead of asking for every keystroke.
      adminBookingsQuery = t.value;
      if (adminBookingsTimer) clearTimeout(adminBookingsTimer);
      adminBookingsTimer = setTimeout(function () {
        adminBookingsTimer = null;
        refreshAdminBookings({ page: 1 });
      }, 300);
    }
  });
  adminView.addEventListener("change", function (event) {
    const t = event.target;
    if (t.getAttribute && t.getAttribute("data-admin-backup-root")) {
      adminBackupRoot = t.value;
      adminBackupDirectory = "";
      loadAdminDataFolders(adminBackupRoot, "");
      return;
    }
    if (t.getAttribute && (t.getAttribute("data-admin-restore-upload")
      || t.getAttribute("data-admin-restore-server"))) {
      renderAdminRestoreSummary();
      return;
    }
    if (t.id === "admin-teachers-filter") { adminStatusFilter.teacher = t.value; renderAdminList("teachers", "teacher"); }    if (t.id === "admin-students-filter") { adminStatusFilter.student = t.value; renderAdminList("students", "student"); }
    if (t.id === "admin-teacher-unavailable-select") { loadAdminTeacherUnavailableDates(t.value); }
    if (t.id === "admin-bookings-status") { refreshAdminBookings({ status: t.value, page: 1 }); }
    if (t.id === "admin-bookings-search") { refreshAdminBookings({ query: t.value, page: 1 }); }
    if (t.id === "admin-overview-audit-action" || t.id === "admin-audit-action") {
      adminAuditFilters.action = t.value.trim();
      adminAuditPage = 1;
      refreshAdminAudit(1);
    }
    if (t.id === "admin-overview-audit-actor" || t.id === "admin-audit-actor") {
      adminAuditFilters.actor_id = t.value;
      adminAuditPage = 1;
      refreshAdminAudit(1);
    }
    if (t.id === "admin-overview-audit-search" || t.id === "admin-audit-search") {
      adminAuditFilters.search = t.value.trim();
      adminAuditPage = 1;
      refreshAdminAudit(1);
    }
    if (t.getAttribute && t.getAttribute("data-admin-override")) {
      const parts = t.getAttribute("data-admin-override").split(":");
      const teacherId = String(adminOverridesOpen || "");
      if (!teacherId) return;
      const raw = t.value;
      let value = null;
      if (raw !== "") {
        if (raw.indexOf("{") === 0) {
          value = JSON.parse(raw);
        } else if (raw === "true" || raw === "false") {
          value = raw === "true";
        } else {
          value = raw;
        }
      }
      apiRequest("/admin/teachers/" + encodeURIComponent(teacherId) + "/overrides", {
        method: "PUT",
        body: { group: parts[0], key: parts[1], value: value },
      })
        .then(function (payload) {
          return loadAdminTeacherOverrides(teacherId).then(function () {
            adminToast((payload && payload.message) || "The override was saved.");
          });
        })
        .catch(function (error) { adminToast(apiErrorMessage(error)); });
    }
    ["logo", "logo2", "favicon"].forEach(function (key) {
      if (t.id !== "admin-brand-" + key + "-file") return;
      const err = document.getElementById("admin-brand-" + key + "-error");
      const preview = document.getElementById("admin-brand-" + key + "-preview");
      const file = t.files && t.files[0];
      if (!file) return;
      if (["image/png", "image/jpeg", "image/webp"].indexOf(file.type) === -1) {
        err.textContent = "Unsupported file type. Use PNG, JPEG or WebP.";
        err.hidden = false;
        t.value = "";
        return;
      }
      const limit = key === "favicon" ? 512 * 1024 : 2 * 1024 * 1024;
      if (file.size > limit) {
        err.textContent = "That image is larger than " + (key === "favicon" ? "512 KB" : "2 MB") + ".";
        err.hidden = false;
        t.value = "";
        return;
      }
      pendingBrandFiles[key] = file;
      err.hidden = true;
      if (preview) {
        const objectUrl = URL.createObjectURL(file);
        preview.innerHTML = '<img alt="" src="' + escapeAttr(objectUrl) + '" />';
      }
      auditAdmin("Branding", key, "", "selected (" + file.type + ", " + Math.round(file.size / 1024) + " KB)");
      adminToast("Image selected. Publish branding to upload and apply it.");
    });
  });

  /* ============== user-facing contact + terms integration ============= */
  function renderContactSections() {
    document.querySelectorAll("[data-contact-mount]").forEach(function (box) {
      box.innerHTML = contactSectionHtml(platformSettings.contact);
    });
  }
  // The published document a member of the given role accepts: the version
  // published for that role, or the common version when the role has none of
  // its own. This is the same precedence the backend uses when it records the
  // acceptance, so the document shown here is the document that is recorded.
  function applicableTermsDoc(role) {
    const terms = platformSettings.terms || {};
    if (terms[role] && (terms[role].title || terms[role].body)) {
      return terms[role];
    }
    if (terms.common && (terms.common.title || terms.common.body)) {
      return terms.common;
    }
    const brand = (platformSettings && platformSettings.branding && platformSettings.branding.appName) || "EduPlatform";
    return {
      role: role || "common",
      version: "1.0.0",
      title: brand + " Terms of Service & Platform Policies",
      body: "By continuing, you agree to " + brand + "'s Terms of Service and Privacy Policy.",
      effectiveDate: "2026-11-13",
      publishedBy: "Administrator",
    };
  }
  function renderTermsLinks() {
    document.querySelectorAll("[data-terms-link]").forEach(function (btn) {
      const role = btn.getAttribute("data-terms-link");
      const doc = applicableTermsDoc(role);
      btn.hidden = !doc;
      // The row that holds the links goes with them, so no empty separator is
      // left behind when there is no published document.
      const row = btn.closest("[data-terms-links]");
      if (row) row.hidden = !doc;
    });
  }
  // Safe renderer: text is escaped, so stored content cannot inject markup.
  function renderTermsBody(title, body) {
    const lines = String(body || "").split("\n");
    const out = ['<h4>' + escapeHtml(title || "Terms") + "</h4>"];
    let list = [];
    function flush() {
      if (list.length) { out.push("<ul>" + list.map(function (l) { return "<li>" + l + "</li>"; }).join("") + "</ul>"); list = []; }
    }
    lines.forEach(function (raw) {
      const line = raw.trim();
      if (!line) { flush(); return; }
      if (/^#\s+/.test(line)) { flush(); out.push("<h4>" + escapeHtml(line.replace(/^#\s+/, "")) + "</h4>"); return; }
      if (/^[-*]\s+/.test(line)) { list.push(escapeHtml(line.replace(/^[-*]\s+/, ""))); return; }
      flush();
      out.push("<p>" + escapeHtml(line) + "</p>");
    });
    flush();
    return out.join("");
  }
  function populateTermsView(role) {
    const doc = applicableTermsDoc(role);
    if (!doc) return;
    const mount = document.getElementById("terms-view-body");
    const heading = document.getElementById("terms-view-title");
    const meta = document.getElementById("terms-view-meta");
    if (!mount) return;
    if (heading) heading.textContent = doc.title;
    mount.innerHTML = renderTermsBody(doc.title, doc.body);
    if (meta) {
      meta.textContent = "Version " + doc.version + " · effective " + doc.effectiveDate + " · published by " + doc.publishedBy;
    }
  }
  function openTerms(role) {
    if (currentView && currentView !== "terms") {
      termsReturnView = currentView;
    }
    const doc = applicableTermsDoc(role);
    if (!doc) { showToast("No terms have been published yet."); return; }
    populateTermsView(role);
    navigate("terms");
  }

  
  // ONE notification store shared by every role. Every read/write is filtered
  // by the current user's stable id, so one user can never see or mutate
  // another's notifications.
  const notifications = [];
  let notificationSeq = 0;
  const NOTIFICATION_CATEGORIES = {
    "attendance-reminder": "Attendance reminders",
    "dispute-opened": "Dispute opened",
    "dispute-resolved": "Dispute resolved",
    "booking-update": "Booking updates",
    "review-update": "Review updates",
    system: "Platform announcements",
  };
  const NOTIFICATION_SETTINGS_DEFAULTS = {
    enabled: {
      "attendance-reminder": true, "dispute-opened": true, "dispute-resolved": true,
      "booking-update": true, "review-update": true, system: true,
    },
    reminderDelayHours: 6,
    reminderIntervalHours: 24,
    maxReminderAttempts: 3,
    notifyAdminsOnDispute: true,
    notifyPartiesOnResolution: true,
  };

  function notifSettings() {
    if (!platformSettings.notifications) {
      platformSettings.notifications = deepClone(NOTIFICATION_SETTINGS_DEFAULTS);
    }
    return platformSettings.notifications;
  }
  function categoryEnabled(cat) { return notifSettings().enabled[cat] !== false; }

  // `dedupeKey` makes creation idempotent so repeated processing cannot spam.

  // Authorization: only the owner's notifications are ever returned.
  function notificationsFor(recipientId) {
    if (!recipientId) return [];
    const owner = String(recipientId);
    return notifications
      .filter(function (n) { return String(n.recipientId) === owner; })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  }
  function unreadCount(recipientId) {
    return notificationsFor(recipientId).filter(function (n) { return !n.read; }).length;
  }
  function markNotificationRead(id, recipientId) {
    const owner = String(recipientId);
    const n = notifications.filter(function (x) {
      return String(x.id) === String(id) && String(x.recipientId) === owner;
    })[0];
    if (!n) return false;
    if (!n.read) { n.read = true; n.readAt = new Date().toISOString(); }
    updateNotificationBadges();
    return true;
  }
  function markAllRead(recipientId) {
    const owner = String(recipientId);
    let changed = 0;
    notifications.forEach(function (n) {
      if (String(n.recipientId) === owner && !n.read) {
        n.read = true; n.readAt = new Date().toISOString(); changed += 1;
      }
    });
    updateNotificationBadges();
    return changed;
  }
  function updateNotificationBadges() {
    [["dash", currentTeacherId()], ["sdash", currentStudentId()]].forEach(function (pair) {
      const badge = document.getElementById(pair[0] + "-notif-badge");
      if (!badge) return;
      const count = pair[1] ? unreadCount(pair[1]) : 0;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    });
    const adminBadge = document.getElementById("admin-notif-badge");
    if (adminBadge) {
      const pending = reviewCases().length;
      adminBadge.textContent = String(pending);
      adminBadge.hidden = pending === 0;
    }
  }

  /* ========================= pagination (Section 8) ==================== */
  // One paginator used by every list. Page numbers and sizes are validated, and
  // an out-of-range page falls back to the last valid page rather than erroring.
  const PAGE_SIZES = [5, 10, 25];
  function paginate(items, page, size) {
    const total = items.length;
    const per = PAGE_SIZES.indexOf(size) === -1 ? PAGE_SIZES[1] : size;
    const pages = Math.max(1, Math.ceil(total / per));
    let p = Number(page);
    if (!isFinite(p) || p < 1) p = 1;
    if (p > pages) p = pages;
    const start = (p - 1) * per;
    return { page: p, size: per, pages: pages, total: total, slice: items.slice(start, start + per) };
  }
  function renderPager(container, state, onGo) {
    container.innerHTML = "";
    container.hidden = state.total <= state.size && state.page === 1 && state.pages === 1;
    if (state.total === 0) { container.hidden = true; return; }
    const info = el("p", "pager__info",
      "Showing " + (state.slice.length ? ((state.page - 1) * state.size + 1) : 0) + "–" +
      ((state.page - 1) * state.size + state.slice.length) + " of " + state.total);
    container.appendChild(info);

    const controls = el("div", "pager__controls");
    const prev = el("button", "pager__btn", "Previous");
    prev.type = "button";
    prev.disabled = state.page <= 1;
    prev.addEventListener("click", function () { onGo(state.page - 1, state.size); });
    const label = el("span", "pager__page", "Page " + state.page + " of " + state.pages);
    const next = el("button", "pager__btn", "Next");
    next.type = "button";
    next.disabled = state.page >= state.pages;
    next.addEventListener("click", function () { onGo(state.page + 1, state.size); });

    const sizeSel = document.createElement("select");
    sizeSel.className = "pager__size";
    sizeSel.setAttribute("aria-label", "Records per page");
    PAGE_SIZES.forEach(function (s) {
      const o = document.createElement("option");
      o.value = String(s); o.textContent = s + " per page";
      if (s === state.size) o.selected = true;
      sizeSel.appendChild(o);
    });
    sizeSel.addEventListener("change", function () { onGo(1, Number(sizeSel.value)); });

    controls.appendChild(prev);
    controls.appendChild(label);
    controls.appendChild(next);
    controls.appendChild(sizeSel);
    container.appendChild(controls);
  }

  /* ===================== notification center (Section 2) ============== */
  const notifState = { dash: { page: 1, size: 10, filter: "all" }, sdash: { page: 1, size: 10, filter: "all" } };

  function notificationCard(n) {
    const card = el("article", "bkcard" + (n.read ? "" : " bkcard--unread"));
    card.setAttribute("data-notification", n.id);
    const head = el("div", "bkcard__head");
    const idw = el("div", "bkcard__identity");
    idw.appendChild(el("h3", "bkcard__teacher", n.title));
    idw.appendChild(el("p", "bkcard__meta",
      (NOTIFICATION_CATEGORIES[n.category] || n.category) + " · " +
      new Date(n.createdAt).toLocaleString()));
    head.appendChild(idw);
    const pill = el("span", "status status--" + (n.read ? "cancelled" : "pending"), n.read ? "Read" : "Unread");
    head.appendChild(pill);
    card.appendChild(head);
    card.appendChild(el("p", "bkcard__note", n.message));
    const actions = el("div", "bkcard__actions");
    if (!n.read) {
      const btn = el("button", "btn btn--ghost");
      btn.type = "button";
      btn.setAttribute("data-notif-read", n.id);
      btn.innerHTML = '<span class="btn__label">Mark as read</span>';
      actions.appendChild(btn);
    }
    if (n.refId) {
      const ref = el("p", "bkcard__note", "Related to " + n.refType + " " + n.refId);
      actions.appendChild(ref);
    }
    card.appendChild(actions);
    return card;
  }

  function renderNotificationCenter(which) {
    const isTeacher = which === "dash";
    const userId = isTeacher ? currentTeacherId() : currentStudentId();
    const st = notifState[which];
    const list = document.getElementById(which + "-notif-list");
    const empty = document.getElementById(which + "-notif-empty");
    const summary = document.getElementById(which + "-notif-summary");
    const pager = document.getElementById(which + "-notif-pager");
    const emptyTitle = document.getElementById(which + "-notif-empty-title");
    const emptyText = document.getElementById(which + "-notif-empty-text");
    if (!list) return;

    const all = notificationsFor(userId);
    const filtered = st.filter === "unread"
      ? all.filter(function (n) { return !n.read; })
      : all;
    const state = paginate(filtered, st.page, st.size);
    st.page = state.page;

    const unread = all.filter(function (n) { return !n.read; }).length;
    summary.textContent = all.length
      ? unread + " unread of " + all.length + " notification" + (all.length === 1 ? "" : "s") + "."
      : "You have no notifications yet.";

    list.innerHTML = "";
    state.slice.forEach(function (n) { list.appendChild(notificationCard(n)); });

    empty.hidden = state.slice.length > 0;
    emptyTitle.textContent = all.length ? "Nothing with this filter" : "No notifications yet";
    emptyText.textContent = all.length
      ? "You have no notifications matching this filter."
      : "Attendance reminders, booking updates and dispute outcomes will appear here.";

    renderPager(pager, state, function (page, size) {
      st.page = page; st.size = size;
      renderNotificationCenter(which);
    });
    updateNotificationBadges();
  }

  function wireNotificationCenter(which) {
    const filters = document.getElementById(which + "-notif-filters");
    const readAll = document.getElementById(which + "-notif-readall");
    const list = document.getElementById(which + "-notif-list");
    if (!filters || !list) return;
    filters.addEventListener("click", function (event) {
      const btn = event.target.closest("[data-notiffilter]");
      if (!btn) return;
      notifState[which].filter = btn.getAttribute("data-notiffilter");
      notifState[which].page = 1;
      filters.querySelectorAll("[data-notiffilter]").forEach(function (b) {
        const active = b.getAttribute("data-notiffilter") === notifState[which].filter;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", String(active));
      });
      renderNotificationCenter(which);
    });
    list.addEventListener("click", function (event) {
      const btn = event.target.closest("[data-notif-read]");
      if (!btn) return;
      const userId = which === "dash" ? currentTeacherId() : currentStudentId();
      const id = btn.getAttribute("data-notif-read");
      // Ownership is re-checked inside markNotificationRead.
      if (!markNotificationRead(id, userId)) {
        showToast("That notification could not be found for this account.");
        return;
      }
      renderNotificationCenter(which);
      // The read state is stored on the server, so it survives a reload.
      apiRequest("/notifications/" + encodeURIComponent(id) + "/read", { method: "PATCH" })
        .catch(function (error) {
          loadNotifications().then(function () {
            renderNotificationCenter(which);
            showToast(apiErrorMessage(error));
          });
        });
    });
    if (readAll) {
      readAll.addEventListener("click", function () {
        const userId = which === "dash" ? currentTeacherId() : currentStudentId();
        const n = markAllRead(userId);
        renderNotificationCenter(which);
        showToast(n ? n + " notification" + (n === 1 ? "" : "s") + " marked as read." : "Nothing was unread.");
        if (!n) return;
        apiRequest("/notifications/read-all", { method: "POST" })
          .catch(function (error) {
            loadNotifications().then(function () {
              renderNotificationCenter(which);
              showToast(apiErrorMessage(error));
            });
          });
      });
    }
  }

  /* ============ attendance reminders (Section 3) ====================== */
  // Safe to run repeatedly: every reminder carries a dedupe key per record,
  // recipient and attempt, so a second run creates nothing new.
  function attendanceReminderCandidates() {
    const s = notifSettings();
    const now = Date.now();
    return attendance.filter(function (a) {
      if (!a || a.confirmation !== "pending") return false;   // resolved records never remind
      if (attendanceIsUnderReview(a)) return false;           // under review is not actionable
      const marked = a.markedAt ? Date.parse(a.markedAt) : 0;
      if (!marked) return false;
      const hours = (now - marked) / 3600000;
      if (hours < s.reminderDelayHours) return false;         // too soon
      const sent = notifications.filter(function (n) {
        return n.dedupeKey.indexOf("reminder:") === 0 && n.refId === a.id && n.recipientId === a.studentId;
      }).length;
      if (sent >= s.maxReminderAttempts) return false;        // attempt limit reached
      if (sent > 0) {
        const last = notifications
          .filter(function (n) { return n.dedupeKey.indexOf("reminder:") === 0 && n.refId === a.id; })
          .map(function (n) { return Date.parse(n.createdAt); })
          .sort(function (x, y) { return y - x; })[0];
        if (last && (now - last) / 3600000 < s.reminderIntervalHours) return false;
      }
      return true;
    });
  }

  /* ============ attendance statistics (Section 5) ===================== */
  // ONE calculation used by the dashboard, the CSV, the Excel export and the
  // PDF, so the numbers can never disagree.
  function attendanceStats(records) {
    const stats = {
      total: records.length, confirmed: 0, pending: 0, disputed: 0, underReview: 0,
      present: 0, absent: 0, currentPresent: 0, currentAbsent: 0,
      byMonth: {}, byDay: {},
    };
    records.forEach(function (r) {
      if (r.confirmation === "confirmed") stats.confirmed += 1;
      if (r.confirmation === "pending") stats.pending += 1;
      if (r.confirmation === "disputed") stats.disputed += 1;
      if (attendanceIsUnderReview(r)) stats.underReview += 1;
      if (r.result === "present") stats.present += 1;
      if (r.result === "absent") stats.absent += 1;
      const cur = r.currentResult || r.result;
      if (cur === "present") stats.currentPresent += 1;
      if (cur === "absent") stats.currentAbsent += 1;
      const month = String(r.date || "").slice(0, 7);
      if (month) {
        stats.byMonth[month] = stats.byMonth[month] || { total: 0, confirmed: 0, pending: 0, disputed: 0 };
        stats.byMonth[month].total += 1;
        if (r.confirmation === "confirmed") stats.byMonth[month].confirmed += 1;
        if (r.confirmation === "pending") stats.byMonth[month].pending += 1;
        if (r.confirmation === "disputed") stats.byMonth[month].disputed += 1;
      }
      const day = r.date || "";
      if (day) {
        stats.byDay[day] = stats.byDay[day] || { total: 0, confirmed: 0, pending: 0, disputed: 0 };
        stats.byDay[day].total += 1;
        if (r.confirmation === "confirmed") stats.byDay[day].confirmed += 1;
        if (r.confirmation === "pending") stats.byDay[day].pending += 1;
        if (r.confirmation === "disputed") stats.byDay[day].disputed += 1;
      }
    });
    return stats;
  }
  function filterByRange(records, from, to) {
    return records.filter(function (r) {
      if (from && String(r.date || "") < from) return false;
      if (to && String(r.date || "") > to) return false;
      return true;
    });
  }
  function renderAttendanceStats(containerId, records, label) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = "";
    const s = attendanceStats(records);
    if (!s.total) {
      box.appendChild(adminEmpty("No attendance data in this range",
        "Adjust the date range or record attendance to see a summary."));
      return;
    }
    const grid = el("div", "bk-stats");
    [
      ["Lessons recorded", s.total], ["Confirmed", s.confirmed], ["Pending", s.pending],
      ["Disputed", s.disputed], ["Under review", s.underReview],
      ["Marked present", s.present], ["Marked absent", s.absent],
    ].forEach(function (pair) {
      const card = el("div", "bk-stat");
      card.appendChild(el("p", "bk-stat__value", String(pair[1])));
      card.appendChild(el("p", "bk-stat__label", pair[0]));
      grid.appendChild(card);
    });
    box.appendChild(grid);
    const months = Object.keys(s.byMonth).sort().reverse().slice(0, 6);
    if (months.length) {
      box.appendChild(el("h4", "tp-section__title", label || "Monthly summary"));
      const table = el("div", "bk-list");
      months.forEach(function (m) {
        const row = s.byMonth[m];
        const card = el("article", "bkcard");
        card.appendChild(el("h3", "bkcard__teacher", m));
        card.appendChild(el("p", "bkcard__note",
          row.total + " lesson" + (row.total === 1 ? "" : "s") + " · " + row.confirmed + " confirmed · " +
          row.pending + " pending · " + row.disputed + " disputed"));
        table.appendChild(card);
      });
      box.appendChild(table);
    }
    box.appendChild(el("p", "field__hint",
      "Each lesson is counted once. Pending and disputed lessons are never counted as confirmed."));
  }


  /* ============ genuine XLSX export (Section 6) ======================= */
  // A real .xlsx is an OOXML zip. This writes a store-only (uncompressed) zip
  // with the minimum parts Excel needs, so the download opens as a workbook —
  // it is never a renamed CSV.
  const CRC_TABLE = (function () {
    const t = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(str) {
    const out = [];
    for (let i = 0; i < str.length; i += 1) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function zipStore(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach(function (f) {
      const nameBytes = utf8(f.name);
      const data = typeof f.data === "string" ? utf8(f.data) : f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      parts.push(local, data);
      central.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: offset });
      offset += local.length + data.length;
    });
    const cdParts = [];
    let cdSize = 0;
    central.forEach(function (c) {
      const h = new Uint8Array(46 + c.nameBytes.length);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true); dv.setUint16(14, 0, true);
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.size, true); dv.setUint32(24, c.size, true);
      dv.setUint16(28, c.nameBytes.length, true);
      dv.setUint32(42, c.offset, true);
      h.set(c.nameBytes, 46);
      cdParts.push(h);
      cdSize += h.length;
    });
    const end = new Uint8Array(22);
    const edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, central.length, true); edv.setUint16(10, central.length, true);
    edv.setUint32(12, cdSize, true); edv.setUint32(16, offset, true);
    return new Blob(parts.concat(cdParts, [end]), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  function xmlEsc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  // Formula injection: a cell that starts with = + - @ is written as text.
  function sheetCell(v, type) {
    const raw = v === null || v === undefined ? "" : String(v);
    if (type === "n") return '<c t="n"><v>' + (isFinite(Number(raw)) ? Number(raw) : 0) + "</v></c>";
    const safe = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw;
    return '<c t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(safe) + "</t></is></c>";
  }
  function buildXlsx(headers, rows, sheetName) {
    const colLetter = function (i) {
      let s = ""; i += 1;
      while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
      return s;
    };
    const headerRow = "<row>" + headers.map(function (h) { return sheetCell(h, "s"); }).join("") + "</row>";
    const bodyRows = rows.map(function (r) {
      return "<row>" + r.map(function (cell) {
        return sheetCell(cell.v, cell.t);
      }).join("") + "</row>";
    }).join("");
    const cols = "<cols>" + headers.map(function (h, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.min(40, Math.max(12, h.length + 4)) + '" customWidth="1"/>';
    }).join("") + "</cols>";
    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      cols + "<sheetData>" + headerRow + bodyRows + "</sheetData></worksheet>";
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + xmlEsc((sheetName || "Attendance").slice(0, 31)) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      "</Types>";
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    return zipStore([
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: rootRels },
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: wbRels },
      { name: "xl/worksheets/sheet1.xml", data: sheet },
    ]);
  }

  /* ============== genuine PDF export (Section 6) ====================== */
  // A minimal but valid multi-page PDF 1.4 with the base-14 Helvetica font.
  function pdfEsc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/[^\x20-\x7e]/g, "?")
      .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  }
  function buildPdf(lines) {
    const PER_PAGE = 46;
    const pages = [];
    for (let i = 0; i < Math.max(1, Math.ceil(lines.length / PER_PAGE)); i += 1) {
      pages.push(lines.slice(i * PER_PAGE, (i + 1) * PER_PAGE));
    }
    const objects = [];
    const kids = [];
    const pageCount = pages.length;
    // 1 catalog, 2 pages, 3 font, then per page: content + page objects
    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    const pageObjStart = 4;
    const pageIds = pages.map(function (_, i) { return pageObjStart + i * 2 + 1; });
    objects.push("<< /Type /Pages /Kids [" + pageIds.map(function (id) { return id + " 0 R"; }).join(" ") +
      "] /Count " + pageCount + " >>");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    pages.forEach(function (pageLines, i) {
      let content = "BT /F1 11 Tf 50 790 Td 14 TL\n";
      pageLines.forEach(function (line, li) {
        content += (li === 0 ? "" : "T*\n") + "(" + pdfEsc(line) + ") Tj\n";
      });
      content += "ET\n";
      const stream = "<< /Length " + content.length + " >>\nstream\n" + content + "endstream";
      objects.push(stream);
      objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents " +
        (pageObjStart + i * 2) + " 0 R >>");
    });
    let pdf = "%PDF-1.4\n";
    const offsets = [];
    objects.forEach(function (body, i) {
      offsets.push(pdf.length);
      pdf += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
    });
    const xrefPos = pdf.length;
    pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
    offsets.forEach(function (off) {
      pdf += String(off).padStart(10, "0") + " 00000 n \n";
    });
    pdf += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF";
    return new Blob([pdf], { type: "application/pdf" });
  }

  function safeFileName(base, ext) {
    const stamp = localDateISO().replace(/-/g, "");
    const clean = String(base || "export").replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "export";
    return clean + "-" + stamp + "." + ext;
  }
  function downloadBlob(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      return true;
    } catch (err) {
      showToast("This environment blocked the download. The records are still shown on screen.");
      return false;
    }
  }
  // Shared row builder so CSV, Excel and PDF never disagree.
  function attendanceExportRows(records, view) {
    return records.map(function (r) {
      const open = openCorrectionFor(r.id);
      return [
        r.id, r.bookingId, r.date, r.time, r.subject, r.modeLabel,
        view === "teacher" ? r.studentName : r.teacherName,
        ATTENDANCE_RESULT_LABELS[r.result] || r.result,
        ATTENDANCE_RESULT_LABELS[r.currentResult || r.result] || "",
        attendanceStatusLabel(r),
        r.absenceReason || "",
        r.studentResponse || "",
        open ? open.status + ": " + open.explanation : "",
        r.markedAt || "",
      ];
    });
  }
  const ATTENDANCE_EXPORT_HEADERS = [
    "Attendance ID", "Booking ID", "Lesson date", "Lesson time", "Subject", "Teaching mode",
    "Person", "Teacher result", "Current result", "Confirmation status", "Absence reason",
    "Student dispute", "Correction request", "Marked at",
  ];
  function exportAttendance(records, view, format) {
    if (!records.length) { showToast("There is nothing to export with these filters."); return false; }
    const rows = attendanceExportRows(records, view);
    const who = view === "teacher" ? "Teacher" : "Student";
    if (format === "xlsx") {
      const data = [ATTENDANCE_EXPORT_HEADERS.map(function (h) { return { v: h, t: "s" }; })];
      rows.forEach(function (r) { data.push(r.map(function (c) { return { v: c, t: "s" }; })); });
      // Summary block appended below the detail rows.
      const s = attendanceStats(records);
      data.push([]);
      data.push([{ v: "Summary", t: "s" }]);
      [["Lessons recorded", s.total], ["Confirmed", s.confirmed], ["Pending", s.pending],
       ["Disputed", s.disputed], ["Marked present", s.present], ["Marked absent", s.absent]]
        .forEach(function (p) { data.push([{ v: p[0], t: "s" }, { v: p[1], t: "n" }]); });
      return downloadBlob(buildXlsx(ATTENDANCE_EXPORT_HEADERS, data.slice(1), "Attendance"),
        safeFileName("attendance-" + who.toLowerCase(), "xlsx"));
    }
    if (format === "pdf") {
      const s = attendanceStats(records);
      const appName = platformSettings.branding.appName || "EduPlatform";
      const lines = [
        appName + " — Attendance report",
        "Generated: " + new Date().toLocaleString(),
        "Scope: " + who + " · records: " + records.length,
        "Summary — recorded " + s.total + ", confirmed " + s.confirmed + ", pending " + s.pending +
          ", disputed " + s.disputed + ", present " + s.present + ", absent " + s.absent,
        "",
        "Date        Time   Subject            Person              Result    Status",
        "----------------------------------------------------------------------------",
      ];
      records.forEach(function (r) {
        lines.push(
          String(r.date || "").padEnd(11) + " " + String(r.time || "").padEnd(6) + " " +
          String(r.subject || "").slice(0, 18).padEnd(18) + " " +
          String((view === "teacher" ? r.studentName : r.teacherName) || "").slice(0, 19).padEnd(19) + " " +
          String(ATTENDANCE_RESULT_LABELS[r.currentResult || r.result] || "").padEnd(9) + " " +
          attendanceStatusLabel(r)
        );
      });
      return downloadBlob(buildPdf(lines), safeFileName("attendance-" + who.toLowerCase(), "pdf"));
    }
    return false;
  }

  studentReviewLogin.addEventListener("click", function () {
    navigate("studentLogin");
  });

  /* ============ Sandboxed-preview compatibility ========================= */
  // In-app preview panes render pages inside a sandboxed iframe without the
  // `allow-forms` permission. That blocks form submission, so the native
  // `submit` event never fires and every form silently does nothing. Click
  // events still work, so drive each form's submit handling from its button.
  function wireSubmitButton(form, button) {
    if (!form || !button) return;
    button.addEventListener("click", function (event) {
      // Stop the (possibly blocked) native submission...
      event.preventDefault();
      // ...and run the form's own submit handling exactly once.
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  // Prevent accidental premature form submission on Enter key in text fields,
  // which previously validated the entire form and turned all empty inputs red.
  // Instead:
  // 1. Validates ONLY the active input field (if a field validator exists).
  //    - If invalid: highlights that single field and keeps focus on it.
  //    - If valid: clears any existing error on that field.
  // 2. Cleanly advances focus to the next interactive field.
  // 3. For login forms (submitOnLastInput === true), Enter in password submits.
  function wireEnterToAdvance(form, submitOnLastInput, fieldValidatorMap) {
    if (!form) return;
    form.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (!target) return;
      if (target.tagName === "TEXTAREA" || target.type === "submit" || target.type === "button") return;
      if (target.tagName !== "INPUT" && target.tagName !== "SELECT") return;

      const focusables = Array.from(form.querySelectorAll("input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), button[type='submit']:not([disabled])"))
        .filter(function (el) {
          return el.offsetParent !== null && window.getComputedStyle(el).visibility !== "hidden";
        });

      const idx = focusables.indexOf(target);
      if (idx === -1) {
        event.preventDefault();
        return;
      }

      // Check if there is a validator for the current active field
      const fieldContainer = target.closest("[data-field]");
      const fieldName = fieldContainer ? fieldContainer.getAttribute("data-field") : null;
      if (fieldValidatorMap && fieldName && typeof fieldValidatorMap[fieldName] === "function") {
        const errorMsg = fieldValidatorMap[fieldName]();
        if (errorMsg) {
          event.preventDefault();
          setFieldError(fieldName, errorMsg);
          target.focus({ preventScroll: true });
          return;
        } else {
          setFieldError(fieldName, "");
        }
      }

      let nextIdx = idx + 1;
      // If current is an email and next is country code selector, skip country select directly to the phone number input
      if (nextIdx < focusables.length && focusables[nextIdx].name && focusables[nextIdx].name.includes("country")) {
        if (nextIdx + 1 < focusables.length) nextIdx++;
      }

      const next = focusables[nextIdx];
      if (next) {
        if (next.type === "submit" || next.tagName === "BUTTON") {
          if (submitOnLastInput) {
            return; // let native submit fire (e.g. password on login form)
          }
        }
        event.preventDefault();
        next.focus();
        if (typeof next.select === "function" && next.tagName === "INPUT" && next.type !== "checkbox" && next.type !== "radio") {
          try { next.select(); } catch (_) {}
        }
      } else {
        if (!submitOnLastInput) {
          event.preventDefault();
        }
      }
    });
  }

  wireSubmitButton(loginForm, loginBtn);
  wireEnterToAdvance(loginForm, true, {
    "login-email": validateLoginEmail,
    "login-password": validateLoginPassword,
  });

  wireSubmitButton(teacherForm, teacherSubmit);
  wireEnterToAdvance(teacherForm, false, {
    "teacher-name": validateName,
    "teacher-email": validateTeacherEmail,
    "teacher-phone": function () { return validatePhoneNumber("teacher"); },
    "teacher-password": validateTeacherPassword,
    "teacher-confirm": validateConfirm,
  });

  wireSubmitButton(profileForm, profileContinue);
  wireEnterToAdvance(profileForm, false, {
    "profile-name": validateProfileName,
    "profile-email": validateProfileEmail,
  });

  wireSubmitButton(qualForm, qualContinue);
  wireEnterToAdvance(qualForm, false);

  wireSubmitButton(subjectsForm, subjectsContinue);
  wireEnterToAdvance(subjectsForm, false);

  wireSubmitButton(locationForm, locationContinue);
  wireEnterToAdvance(locationForm, false, {
    "loc-country": validateCountry,
    "loc-state": validateState,
    "loc-city": validateCity,
    "loc-area": validateArea,
  });

  wireSubmitButton(availabilityForm, availabilityContinue);
  wireEnterToAdvance(availabilityForm, false);

  
  wireSubmitButton(studentForm, studentSubmit);
  wireEnterToAdvance(studentForm, false, {
    "student-name": function () { return validateStudentFullName(sName.value); },
    "student-email": function () { return validateEmailValue(sEmail.value); },
    "student-phone": function () { return validatePhoneNumber("student"); },
    "student-password": function () { return validateStudentPassword(sPassword.value); },
    "student-confirm": function () { return validateStudentConfirm(sConfirm.value, sPassword.value); },
    "student-grade": function () { return validateStudentLevel(sGrade.value, sGradeOther.value.trim()); },
  });

  wireSubmitButton(studentLoginForm, studentLoginBtn);
  wireEnterToAdvance(studentLoginForm, true, {
    "student-login-email": function () { return validateEmailValue(sLoginEmail.value); },
    "student-login-password": function () { return validateStudentPassword(sLoginPassword.value); },
  });

  wireSubmitButton(studentProfileForm, studentProfileContinue);
  wireEnterToAdvance(studentProfileForm, false, {
    "student-profile-name": function () { return validateStudentFullName(sProfileName.value); },
    "student-profile-email": function () { return validateEmailValue(sProfileEmail.value); },
    "student-profile-grade": function () { return validateStudentLevel(sProfileGrade.value, sProfileGradeOther.value.trim()); },
  });

  
  wireSubmitButton(ftSearchForm, ftSearchBtn);

  
  wireSubmitButton(bookForm, bookSubmit);
  wireEnterToAdvance(bookForm, false);

  
  wireSubmitButton(rvForm, rvSubmit);
  wireEnterToAdvance(rvForm, false);

  /* ============================== Init ================================= */
  // Open whatever the URL asks for (so refresh and direct links work), and
  // record that as the first history entry. Guarded so a restricted History
  // API can never stop the app from starting.
  try {
    const hashView = viewFromHash(location.hash);
    const startView = hashView || "login";
    try {
      // Keep a recognised hash exactly as-is so dashboard tab deep links
      // (e.g. #/dashboard/profile) survive a refresh or direct open; only
      // unknown hashes are normalised to the view's canonical route.
      history.replaceState({ view: startView }, "", hashView ? location.hash : ROUTES[startView].hash);
    } catch (err) {
      /* History unavailable - the app still works, only the URL isn't synced. */
    }
    // Build the subject / grade / stream option lists once.
    renderCheckList(subjectGrid, COMMON_SUBJECTS, "subject", "subj");
    renderCheckList(gradeGrid, GRADE_OPTIONS, "grade", "grade");
    renderCheckList(streamGrid, STREAM_OPTIONS, "stream", "stream");
    // Days are generated from the same helper so the markup exists once.
    renderCheckList(dayGrid, DAYS, "day", "day");
    dayGrid.querySelectorAll("input").forEach(function (input) {
      input.setAttribute("aria-describedby", "availability-days-error");
    });
    renderAvailabilityDays();
    syncCheckStates();
    renderSubjectChips();
    toggleConditionalFields();

    // Location: country/state dropdowns, radius options, initial mode state.
    populateCountries();
    fillSelect(locRadius, RADIUS_OPTIONS, null);
    locRadius.value = "Within 10 km";
    bindCharCounter(locOnlineTools, onlineToolsCount, 160);
    syncModeCards();
    updateConditionalFields();

    // Start with one (empty) qualification row so the section is never blank.
    if (!qualList.children.length) addQualificationRow();
    resetPasswordToggles();
    init();
    init();
    renderView(startView, { focus: false });

    // FIX 13: loadMeta() was defined but NEVER CALLED, so applyMeta() never ran.
    // platformSettings were never populated from /api/v1/meta, which meant
    // reviewPolicy.configured stayed false forever and the review form was
    // permanently blocked even when the server reported the student eligible.
    // Branding, contact, pricing and published terms were never applied either.
    //
    // FIX 4: restoreSession() then restores an existing session on load. Without
    // it, loadRoleState() ran only from the explicit login handler, so a refresh
    // or deep link left every API-backed screen empty.
    loadMeta().then(restoreSession).then(function (restored) {
      if (!restored) {
        // The visitor is not signed in. Now that /me has answered, do not leave
        // a protected URL in the address bar while showing the login screen.
        const requested = viewFromHash(location.hash);
        if (requested && authRequirementForView(requested)) {
          try {
            history.replaceState({ view: "login" }, "", ROUTES.login.hash);
          } catch (err) {
            /* the login screen is already visible */
          }
        }
        return;
      }
      try {
        const current = viewFromHash(location.hash) || startView;
        const authViews = ["login", "studentLogin", "accountType", "teacherSignup", "studentSignup"];
        if (authViews.indexOf(current) !== -1) {
          navigate(homeRouteForRole());
        } else {
          renderView(current, { focus: false });
        }
      } catch (err) {
        reportError(err && err.message ? err.message : String(err));
      }
    });
  } catch (err) {
    // Never let start-up leave the screen dead.
    try {
      renderView("login", { focus: false });
    } catch (err2) {
      /* nothing more we can do */
    }
    reportError(err && err.message ? err.message : String(err));
  }
})();
