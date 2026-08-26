//! Bounded IPC framing: oversized, truncated and flooded peers all fail closed.

use std::io::Cursor;

use companion::ipc::dto::CompanionRequest;
use companion::ipc::server::{
    parse_request, read_frame, write_frame, FrameError, FrameLimits, RequestAdmission,
    RequestProcessError, SessionAdmissionError,
};

fn small_limits() -> FrameLimits {
    FrameLimits {
        max_frame_bytes: 128,
        max_queue_depth: 4,
        max_concurrent_requests: 2,
    }
}

#[test]
fn a_valid_frame_round_trips() {
    let limits = small_limits();
    let payload = br#"{"protocolMajor":1,"requestId":"req-1","type":"session.pause","payload":{"runId":"run-1"}}"#;
    let mut buffer = Vec::new();
    write_frame(&mut buffer, payload, &limits).expect("write");

    let mut reader = Cursor::new(buffer);
    let body = read_frame(&mut reader, &limits).expect("read");
    assert_eq!(body, payload);
}

#[test]
fn an_oversized_declared_frame_is_rejected_before_allocation() {
    let limits = small_limits();
    // Declared length far exceeds the max, but we send no body: it must be
    // rejected purely from the length prefix.
    let mut framed = Vec::new();
    framed.extend_from_slice(&(1_000_000u32).to_be_bytes());
    let mut reader = Cursor::new(framed);
    assert_eq!(
        read_frame(&mut reader, &limits),
        Err(FrameError::FrameTooLarge)
    );
}

#[test]
fn a_truncated_frame_is_rejected() {
    let limits = small_limits();
    // Prefix promises 10 bytes but only 3 follow.
    let mut framed = Vec::new();
    framed.extend_from_slice(&(10u32).to_be_bytes());
    framed.extend_from_slice(b"abc");
    let mut reader = Cursor::new(framed);
    assert_eq!(read_frame(&mut reader, &limits), Err(FrameError::Truncated));
}

#[test]
fn a_missing_length_prefix_is_rejected() {
    let limits = small_limits();
    let mut reader = Cursor::new(vec![0u8, 1u8]); // fewer than 4 prefix bytes
    assert_eq!(read_frame(&mut reader, &limits), Err(FrameError::Truncated));
}

#[test]
fn writing_an_oversized_payload_is_refused() {
    let limits = small_limits();
    let payload = vec![0u8; 129];
    let mut buffer = Vec::new();
    assert_eq!(
        write_frame(&mut buffer, &payload, &limits),
        Err(FrameError::FrameTooLarge)
    );
}

#[test]
fn an_unknown_request_type_is_rejected() {
    let body = br#"{"protocolMajor":1,"requestId":"req-1","type":"session.explode","payload":{"runId":"run-1"}}"#;
    assert_eq!(parse_request(body), Err(FrameError::Malformed));
}

#[test]
fn raw_flat_legacy_request_is_rejected() {
    let body = br#"{"type":"uia.capture","sessionId":"sess-1","deadlineMs":2000}"#;
    assert_eq!(parse_request(body), Err(FrameError::Malformed));
}

#[test]
fn envelope_payload_unknown_fields_are_rejected() {
    let body = br#"{"protocolMajor":1,"requestId":"req-1","type":"session.pause","payload":{"runId":"run-1","extra":true}}"#;
    assert_eq!(parse_request(body), Err(FrameError::Malformed));
}

#[test]
fn envelope_top_level_unknown_fields_are_rejected() {
    let body = br#"{"protocolMajor":1,"requestId":"req-1","type":"session.pause","payload":{"runId":"run-1"},"extra":true}"#;
    assert_eq!(parse_request(body), Err(FrameError::Malformed));
}

#[test]
fn current_envelope_request_variants_parse() {
    let capture = br#"{"protocolMajor":1,"requestId":"req-1","type":"uia.capture","payload":{"sessionId":"sess-1","deadlineMs":2000}}"#;
    assert!(parse_request(capture).is_ok());

    let probe = br#"{"protocolMajor":1,"requestId":"req-2","type":"companion.probe","payload":{"targetAdapter":"desktop-windows-uia","observationExtension":"uia/v1"}}"#;
    assert!(parse_request(probe).is_ok());

    let launch = br#"{"protocolMajor":1,"requestId":"req-3","type":"app.launch","payload":{"target":{"targetId":"target-1","platform":"windows","launch":{"executable":"C:\\Windows\\System32\\notepad.exe","args":[]},"process":{"expectedImageName":"notepad.exe","allowedChildImageNames":[]},"window":{},"reset":{"command":"reset","args":[],"timeoutMs":1000},"shutdown":{"gracefulTimeoutMs":1000,"forceAfterTimeout":true}}}}"#;
    assert!(parse_request(launch).is_ok());
}

#[test]
fn concurrent_request_flooding_is_bounded() {
    let admission = RequestAdmission::new(2);
    let g1 = admission.try_admit().expect("first admitted");
    let g2 = admission.try_admit().expect("second admitted");
    assert_eq!(admission.in_flight(), 2);
    // A third concurrent request is rejected while the first two are in flight.
    assert_eq!(admission.try_admit().err(), Some(FrameError::Overloaded));

    drop(g1);
    // Releasing a slot lets a new request through.
    let _g3 = admission.try_admit().expect("admitted after release");
    drop(g2);
}

#[test]
fn queued_request_depth_is_bounded_independently_from_in_flight_work() {
    let limits = FrameLimits {
        max_frame_bytes: 1024,
        max_queue_depth: 2,
        max_concurrent_requests: 1,
    };
    let admission = RequestAdmission::from_frame_limits(&limits);
    let q1 = admission.try_queue().expect("first queued");
    let q2 = admission.try_queue().expect("second queued");
    assert_eq!(admission.queued(), 2);
    assert_eq!(admission.try_queue().err(), Some(FrameError::Overloaded));

    drop(q2);
    let in_flight = q1.try_start().expect("first starts");
    assert_eq!(admission.queued(), 0);
    assert_eq!(admission.in_flight(), 1);

    let q3 = admission.try_queue().expect("queue remains usable");
    assert_eq!(q3.try_start().err(), Some(FrameError::Overloaded));
    drop(in_flight);
}

#[test]
fn request_path_errors_map_to_public_companion_stable_codes() {
    assert_eq!(
        RequestProcessError::Frame(FrameError::FrameTooLarge).stable_code(),
        "CompanionMessageTooLarge"
    );
    assert_eq!(
        RequestProcessError::Frame(FrameError::Overloaded).stable_code(),
        "CompanionBackpressure"
    );
    assert_eq!(
        RequestProcessError::Frame(FrameError::Truncated).stable_code(),
        "CompanionProtocolViolation"
    );
    assert_eq!(
        RequestProcessError::Frame(FrameError::Malformed).stable_code(),
        "CompanionProtocolViolation"
    );
    assert_eq!(
        RequestProcessError::Frame(FrameError::Io).stable_code(),
        "CompanionUnavailable"
    );
    assert_eq!(
        RequestProcessError::Session(SessionAdmissionError::CompanionUnauthenticated).stable_code(),
        "CompanionUnauthenticated"
    );
}

#[test]
fn action_execute_accepts_public_value_ref_field_and_rejects_legacy_value_ref_name() {
    let public = br#"{"protocolMajor":1,"requestId":"req-value","type":"action.execute","payload":{"sessionId":"sess-1","action":{"targetKind":"desktop","kind":"input","actionId":"act-1","graphId":"graph-1","nodeId":"edit-1","resolution":"semantic","uiaPattern":"Value","valueRef":"secret-ref"},"permit":{"permitToken":"permit-1","nonceBase64":"nonce","sessionId":"sess-1","runId":"run-1","actionId":"act-1","actionDigestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","graphId":"graph-1","decisionId":"decision-1","policyId":"policy-1","risk":"ExternalSideEffect","issuedAt":"2026-08-02T00:00:00.000Z","expiresAt":"2026-08-02T00:01:00.000Z","valueBinding":{"valueRef":"secret-ref","valueSha256":"2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b","valueByteLength":6}},"value":{"valueRef":"secret-ref","valueSha256":"2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b","valueByteLength":6,"plaintext":"secret"},"deadlineMs":5000}}"#;
    let parsed_public = CompanionRequest::from_slice(public);
    assert!(parsed_public.is_ok(), "{parsed_public:?}");
    assert!(parse_request(public).is_ok());

    let legacy = br#"{"protocolMajor":1,"requestId":"req-value","type":"action.execute","payload":{"sessionId":"sess-1","action":{"targetKind":"desktop","kind":"input","actionId":"act-1","graphId":"graph-1","nodeId":"edit-1","resolution":"semantic","uiaPattern":"Value","value_ref":"secret-ref"},"permit":{"permitToken":"permit-1","nonceBase64":"nonce","sessionId":"sess-1","runId":"run-1","actionId":"act-1","actionDigestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","graphId":"graph-1","decisionId":"decision-1","policyId":"policy-1","risk":"ExternalSideEffect","issuedAt":"2026-08-02T00:00:00.000Z","expiresAt":"2026-08-02T00:01:00.000Z","valueBinding":{"valueRef":"secret-ref","valueSha256":"2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b","valueByteLength":6}},"value":{"valueRef":"secret-ref","valueSha256":"2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b","valueByteLength":6,"plaintext":"secret"},"deadlineMs":5000}}"#;
    assert_eq!(parse_request(legacy), Err(FrameError::Malformed));
}
