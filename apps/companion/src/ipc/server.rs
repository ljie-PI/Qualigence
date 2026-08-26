//! Bounded, length-prefixed framing for the Companion IPC transport.
//!
//! Every frame is a big-endian 32-bit length prefix followed by exactly that
//! many bytes. Fixed maximums for frame size, queue depth and concurrent
//! in-flight requests are enforced so a partial, oversized or flooded peer fails
//! closed with a stable error instead of exhausting Companion memory or threads.

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::ipc::dto::{CompanionRequest, PROTOCOL_MAJOR};
use crate::ipc::security::AuthenticatedCertificateRunner;

#[derive(Debug, Clone, Copy)]
pub struct FrameLimits {
    pub max_frame_bytes: u32,
    pub max_queue_depth: usize,
    pub max_concurrent_requests: usize,
}

impl Default for FrameLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: 1 << 20, // 1 MiB, matching COMPANION_IPC_LIMITS.maxFrameBytes
            max_queue_depth: 64,
            max_concurrent_requests: 8,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The declared frame length exceeds the configured maximum.
    FrameTooLarge,
    /// The stream ended before a full length prefix or body was read.
    Truncated,
    /// The body was not valid JSON / not a known request type.
    Malformed,
    /// Underlying transport error.
    Io,
    /// Too many requests admitted concurrently.
    Overloaded,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionAdmissionError {
    CompanionUnauthenticated,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RequestProcessError {
    Frame(FrameError),
    Session(SessionAdmissionError),
}

impl RequestProcessError {
    pub fn stable_code(&self) -> &'static str {
        match self {
            Self::Frame(FrameError::FrameTooLarge) => "CompanionFrameTooLarge",
            Self::Frame(FrameError::Truncated) => "CompanionFrameTruncated",
            Self::Frame(FrameError::Malformed) => "CompanionProtocolViolation",
            Self::Frame(FrameError::Io) => "CompanionUnavailable",
            Self::Frame(FrameError::Overloaded) => "CompanionOverloaded",
            Self::Session(SessionAdmissionError::CompanionUnauthenticated) => {
                "CompanionUnauthenticated"
            }
        }
    }
}

impl From<FrameError> for RequestProcessError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl From<SessionAdmissionError> for RequestProcessError {
    fn from(error: SessionAdmissionError) -> Self {
        Self::Session(error)
    }
}

#[derive(Default)]
pub struct AuthenticatedSessionGate {
    authenticated_runner_id: Option<String>,
}

impl AuthenticatedSessionGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accept(&mut self, runner: AuthenticatedCertificateRunner) {
        self.authenticated_runner_id = Some(runner.runner_id);
    }

    pub fn clear(&mut self) {
        self.authenticated_runner_id = None;
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated_runner_id.is_some()
    }

    pub fn require_authenticated(
        &self,
        request: &CompanionRequest,
    ) -> Result<(), SessionAdmissionError> {
        if request.payload.is_handshake() {
            Ok(())
        } else if self.is_authenticated() {
            Ok(())
        } else {
            Err(SessionAdmissionError::CompanionUnauthenticated)
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(_: io::Error) -> Self {
        FrameError::Io
    }
}

/// Read one length-prefixed frame, rejecting an oversized declared length before
/// allocating for the body.
pub fn read_frame<R: Read>(reader: &mut R, limits: &FrameLimits) -> Result<Vec<u8>, FrameError> {
    let mut len_buf = [0u8; 4];
    read_exact(reader, &mut len_buf)?;
    let declared = u32::from_be_bytes(len_buf);
    if declared > limits.max_frame_bytes {
        return Err(FrameError::FrameTooLarge);
    }
    let mut body = vec![0u8; declared as usize];
    read_exact(reader, &mut body)?;
    Ok(body)
}

/// Write one length-prefixed frame, refusing to emit an oversized body.
pub fn write_frame<W: Write>(
    writer: &mut W,
    payload: &[u8],
    limits: &FrameLimits,
) -> Result<(), FrameError> {
    if payload.len() > limits.max_frame_bytes as usize {
        return Err(FrameError::FrameTooLarge);
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(payload)?;
    Ok(())
}

/// Read a frame and strictly deserialize it into a {@link CompanionRequest},
/// rejecting unknown request types and malformed bodies.
pub fn read_request<R: Read>(
    reader: &mut R,
    limits: &FrameLimits,
) -> Result<CompanionRequest, FrameError> {
    let body = read_frame(reader, limits)?;
    parse_request(&body)
}

pub fn parse_request(body: &[u8]) -> Result<CompanionRequest, FrameError> {
    let request = CompanionRequest::from_slice(body).map_err(|_| FrameError::Malformed)?;
    if request.protocol_major != PROTOCOL_MAJOR {
        return Err(FrameError::Malformed);
    }
    Ok(request)
}

fn read_exact<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<(), FrameError> {
    match reader.read_exact(buf) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => Err(FrameError::Truncated),
        Err(err) => Err(err.into()),
    }
}

/// A bounded admission controller for concurrent in-flight requests. Admitting
/// beyond `max_concurrent_requests` fails closed with [`FrameError::Overloaded`].
#[derive(Clone)]
pub struct RequestAdmission {
    queued: Arc<AtomicUsize>,
    in_flight: Arc<AtomicUsize>,
    max_queue_depth: usize,
    max_concurrent: usize,
}

impl RequestAdmission {
    pub fn new(max_concurrent: usize) -> Self {
        Self::with_limits(max_concurrent, max_concurrent)
    }

    pub fn from_frame_limits(limits: &FrameLimits) -> Self {
        Self::with_limits(limits.max_queue_depth, limits.max_concurrent_requests)
    }

    pub fn with_limits(max_queue_depth: usize, max_concurrent: usize) -> Self {
        Self {
            queued: Arc::new(AtomicUsize::new(0)),
            in_flight: Arc::new(AtomicUsize::new(0)),
            max_queue_depth,
            max_concurrent,
        }
    }

    pub fn queued(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// Reserve one bounded queue slot before a decoded request waits for a
    /// worker. The returned guard must be promoted with [`QueuedRequest::try_start`]
    /// or dropped; either path releases the queue slot.
    pub fn try_queue(&self) -> Result<QueuedRequest, FrameError> {
        let prior = self.queued.fetch_add(1, Ordering::SeqCst);
        if prior >= self.max_queue_depth {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return Err(FrameError::Overloaded);
        }
        Ok(QueuedRequest {
            admission: self.clone(),
            queued: true,
        })
    }

    /// Try to admit a request without queueing. Existing callers keep the old
    /// semantics, while server loops that can wait must use [`Self::try_queue`]
    /// first so both `max_queue_depth` and `max_concurrent_requests` are enforced.
    pub fn try_admit(&self) -> Result<AdmissionGuard, FrameError> {
        self.try_start_in_flight()
    }

    fn try_start_in_flight(&self) -> Result<AdmissionGuard, FrameError> {
        let prior = self.in_flight.fetch_add(1, Ordering::SeqCst);
        if prior >= self.max_concurrent {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return Err(FrameError::Overloaded);
        }
        Ok(AdmissionGuard {
            in_flight: Arc::clone(&self.in_flight),
        })
    }
}

pub struct QueuedRequest {
    admission: RequestAdmission,
    queued: bool,
}

impl QueuedRequest {
    pub fn try_start(mut self) -> Result<AdmissionGuard, FrameError> {
        let guard = self.admission.try_start_in_flight()?;
        self.release_queue_slot();
        Ok(guard)
    }

    fn release_queue_slot(&mut self) {
        if self.queued {
            self.admission.queued.fetch_sub(1, Ordering::SeqCst);
            self.queued = false;
        }
    }
}

impl Drop for QueuedRequest {
    fn drop(&mut self) {
        self.release_queue_slot();
    }
}

pub struct AdmissionGuard {
    in_flight: Arc<AtomicUsize>,
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Production request-admission path shared by the native pipe session.
///
/// This keeps the security gate and queue/concurrency counters on the same path
/// that reads and admits decoded Companion requests, so the limits are not just
/// standalone primitives.
pub struct BoundedRequestProcessor {
    limits: FrameLimits,
    admission: RequestAdmission,
    gate: AuthenticatedSessionGate,
}

impl BoundedRequestProcessor {
    pub fn new(limits: FrameLimits) -> Self {
        Self {
            limits,
            admission: RequestAdmission::from_frame_limits(&limits),
            gate: AuthenticatedSessionGate::new(),
        }
    }

    pub fn limits(&self) -> &FrameLimits {
        &self.limits
    }

    pub fn admission(&self) -> &RequestAdmission {
        &self.admission
    }

    pub fn is_authenticated(&self) -> bool {
        self.gate.is_authenticated()
    }

    pub fn accept_runner(&mut self, runner: AuthenticatedCertificateRunner) {
        self.gate.accept(runner);
    }

    pub fn clear_session(&mut self) {
        self.gate.clear();
    }

    pub fn read_admitted_request<R: Read>(
        &mut self,
        reader: &mut R,
    ) -> Result<(CompanionRequest, AdmissionGuard), RequestProcessError> {
        let request = read_request(reader, &self.limits)?;
        self.admit_request(request)
    }

    pub fn admit_request(
        &mut self,
        request: CompanionRequest,
    ) -> Result<(CompanionRequest, AdmissionGuard), RequestProcessError> {
        let queued = self.admission.try_queue()?;
        self.gate.require_authenticated(&request)?;
        let guard = queued.try_start()?;
        Ok((request, guard))
    }
}
