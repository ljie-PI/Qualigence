//! Native Windows Named Pipe authority for the Companion.
//!
//! This module contains the Win32 boundary for Ticket 29. It deliberately has no
//! portable fallback: on non-Windows builds the module is not compiled, and the
//! native tests fail with `Windows11Unavailable` rather than claiming coverage.

#![cfg(windows)]

use std::collections::HashSet;
use std::ffi::c_void;
use std::fmt;
use std::io::{self, Read, Write};
use std::iter::once;
use std::marker::PhantomData;
use std::mem::{size_of, zeroed};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

use crate::clock::Clock;
use crate::ipc::dto::{CompanionRequest, CompanionRequestPayload};
use crate::ipc::security::{
    CertificateHandshakeError, CertificateHandshakeVerifier, CompanionProofSignatureAlgorithm,
};
use crate::ipc::server::{BoundedRequestProcessor, FrameLimits, RequestProcessError};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_BROKEN_PIPE, ERROR_IO_PENDING,
    ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::Cryptography::Catalog::{
    CryptCATAdminAcquireContext2, CryptCATAdminCalcHashFromFileHandle2,
    CryptCATAdminEnumCatalogFromHash, CryptCATAdminReleaseCatalogContext,
    CryptCATAdminReleaseContext, CryptCATCatalogInfoFromContext, CATALOG_INFO,
};
use windows_sys::Win32::Security::Cryptography::{
    CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext,
    CertGetCertificateContextProperty, CryptMsgClose, CryptMsgGetParam, CryptQueryObject,
    CERT_CONTEXT, CERT_FIND_SUBJECT_CERT, CERT_INFO, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
    CERT_QUERY_CONTENT_TYPE, CERT_QUERY_ENCODING_TYPE, CERT_QUERY_FORMAT_FLAG_BINARY,
    CERT_QUERY_FORMAT_TYPE, CERT_QUERY_OBJECT_FILE, CERT_SHA1_HASH_PROP_ID,
    CMSG_SIGNER_COUNT_PARAM, CMSG_SIGNER_INFO, CMSG_SIGNER_INFO_PARAM,
};
use windows_sys::Win32::Security::WinTrust::{
    WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_CATALOG_INFO, WINTRUST_DATA,
    WINTRUST_FILE_INFO, WTD_CHOICE_CATALOG, WTD_CHOICE_FILE, WTD_DISABLE_MD2_MD4,
    WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
    WTD_UICONTEXT_EXECUTE, WTD_UI_NONE,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenGroups, TokenSessionId, TokenUser, SECURITY_ATTRIBUTES, TOKEN_GROUPS,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_FLAG_OVERLAPPED, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::System::SystemServices::SE_GROUP_LOGON_ID;
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(version: *mut OSVERSIONINFOW) -> i32;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativePipeError {
    Windows11Unavailable,
    InvalidPipeName,
    FirstInstanceAlreadyExists,
    Timeout,
    CompanionIdentityRejected,
    UnsupportedSignaturePolicy,
    Win32 { operation: &'static str, code: u32 },
}

impl NativePipeError {
    pub fn stable_code(&self) -> &'static str {
        match self {
            Self::Windows11Unavailable => "Windows11Unavailable",
            Self::InvalidPipeName => "CompanionProtocolViolation",
            Self::FirstInstanceAlreadyExists => "CompanionUnavailable",
            Self::Timeout => "CompanionRequestTimeout",
            Self::CompanionIdentityRejected => "CompanionIdentityRejected",
            Self::UnsupportedSignaturePolicy => "CompanionIdentityRejected",
            Self::Win32 { .. } => "CompanionUnavailable",
        }
    }
}

impl fmt::Display for NativePipeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Win32 { operation, code } => {
                write!(f, "{operation} failed with Win32 error {code}")
            }
            other => write!(f, "{}", other.stable_code()),
        }
    }
}

impl std::error::Error for NativePipeError {}

#[derive(Debug, Clone)]
pub struct NativePipeConfig {
    pub name_prefix: String,
    pub max_frame_bytes: u32,
    pub connect_timeout_ms: u32,
}

impl Default for NativePipeConfig {
    fn default() -> Self {
        Self {
            name_prefix: "qualigence-companion".to_string(),
            max_frame_bytes: 1 << 20,
            connect_timeout_ms: 5_000,
        }
    }
}

#[derive(Debug)]
pub struct NamedPipeListener {
    handle: HANDLE,
    path: String,
    logon_sid: String,
}

impl NamedPipeListener {
    pub fn bind_for_current_logon(config: &NativePipeConfig) -> Result<Self, NativePipeError> {
        assert_windows_11_or_newer()?;
        let logon_sid = current_logon_sid_string()?;
        let path = pipe_path_for_logon_sid(&config.name_prefix, &logon_sid)?;
        Self::bind_path(&path, &logon_sid, config.max_frame_bytes)
    }

    pub fn bind_path_for_tests(
        path: &str,
        logon_sid: &str,
        max_frame_bytes: u32,
    ) -> Result<Self, NativePipeError> {
        Self::bind_path(path, logon_sid, max_frame_bytes)
    }

    fn bind_path(
        path: &str,
        logon_sid: &str,
        max_frame_bytes: u32,
    ) -> Result<Self, NativePipeError> {
        let mut sd = SecurityDescriptor::for_logon_sid(logon_sid)?;
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.as_mut_ptr(),
            bInheritHandle: 0,
        };
        let wide_path = wide(path);
        let handle = unsafe {
            CreateNamedPipeW(
                wide_path.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                max_frame_bytes,
                max_frame_bytes,
                0,
                &mut attrs,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            if code == ERROR_ACCESS_DENIED || code == ERROR_PIPE_BUSY {
                return Err(NativePipeError::FirstInstanceAlreadyExists);
            }
            return Err(NativePipeError::Win32 {
                operation: "CreateNamedPipeW",
                code,
            });
        }
        Ok(Self {
            handle,
            path: path.to_string(),
            logon_sid: logon_sid.to_string(),
        })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn logon_sid(&self) -> &str {
        &self.logon_sid
    }

    pub fn raw_handle(&self) -> HANDLE {
        self.handle
    }

    pub fn connection(&self) -> BorrowedPipeConnection<'_> {
        BorrowedPipeConnection {
            handle: self.handle,
            _owner: PhantomData,
        }
    }

    pub fn connect(&self, timeout_ms: u32) -> Result<(), NativePipeError> {
        let event = OwnedHandle::new(
            unsafe { CreateEventW(null(), 1, 0, null()) },
            "CreateEventW",
        )?;
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        overlapped.hEvent = event.raw();
        let ok = unsafe { ConnectNamedPipe(self.handle, &mut overlapped) };
        if ok != 0 {
            return Ok(());
        }
        let code = unsafe { GetLastError() };
        if code == ERROR_PIPE_CONNECTED {
            return Ok(());
        }
        if code != ERROR_IO_PENDING {
            return Err(NativePipeError::Win32 {
                operation: "ConnectNamedPipe",
                code,
            });
        }
        let wait = unsafe { WaitForSingleObject(event.raw(), timeout_ms) };
        if wait == WAIT_OBJECT_0 {
            Ok(())
        } else if wait == WAIT_TIMEOUT {
            unsafe {
                CancelIoEx(self.handle, &overlapped);
            }
            Err(NativePipeError::Timeout)
        } else {
            Err(NativePipeError::Win32 {
                operation: "WaitForSingleObject",
                code: wait,
            })
        }
    }

    pub fn client_identity(&self) -> Result<WindowsPeerIdentity, NativePipeError> {
        let mut pid = 0u32;
        let ok = unsafe { GetNamedPipeClientProcessId(self.handle, &mut pid) };
        if ok == 0 {
            return Err(last_error("GetNamedPipeClientProcessId"));
        }
        WindowsPeerIdentity::for_pid(pid)
    }
}

impl Drop for NamedPipeListener {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

pub struct AdmittedNativeApplicationRequest {
    pub request: CompanionRequest,
    _admission: crate::ipc::server::AdmissionGuard,
}

pub enum NativePipeRequestEvent {
    ChallengeIssued {
        request_id: String,
        challenge_id: String,
        nonce_base64: String,
    },
    Authenticated {
        request_id: String,
        runner_id: String,
        certificate_sha256_fingerprint: String,
    },
    ApplicationRequest(AdmittedNativeApplicationRequest),
}

#[derive(Debug, PartialEq, Eq)]
pub enum NativePipeRequestError {
    Request(RequestProcessError),
    Handshake(CertificateHandshakeError),
}

impl NativePipeRequestError {
    pub fn stable_code(&self) -> &'static str {
        match self {
            Self::Request(error) => error.stable_code(),
            Self::Handshake(_) => "CompanionIdentityRejected",
        }
    }
}

impl From<RequestProcessError> for NativePipeRequestError {
    fn from(error: RequestProcessError) -> Self {
        Self::Request(error)
    }
}

impl From<CertificateHandshakeError> for NativePipeRequestError {
    fn from(error: CertificateHandshakeError) -> Self {
        Self::Handshake(error)
    }
}

pub struct NativePipeRequestProcessor<C: Clock> {
    requests: BoundedRequestProcessor,
    certificates: CertificateHandshakeVerifier<C>,
}

impl<C: Clock> NativePipeRequestProcessor<C> {
    pub fn new(limits: FrameLimits, certificates: CertificateHandshakeVerifier<C>) -> Self {
        Self {
            requests: BoundedRequestProcessor::new(limits),
            certificates,
        }
    }

    pub fn admission(&self) -> &crate::ipc::server::RequestAdmission {
        self.requests.admission()
    }

    pub fn is_authenticated(&self) -> bool {
        self.requests.is_authenticated()
    }

    pub fn disconnect_cleanup(&mut self) {
        self.requests.clear_session();
        self.certificates.clear_pending_challenges();
    }

    pub fn process_next_request<R: Read>(
        &mut self,
        reader: &mut R,
    ) -> Result<NativePipeRequestEvent, NativePipeRequestError> {
        let (request, admission) = self.requests.read_admitted_request(reader)?;
        let request_id = request.request_id.clone();
        match &request.payload {
            CompanionRequestPayload::HandshakeBegin(payload) => {
                let challenge = self.certificates.begin(
                    request.protocol_major,
                    &payload.runner_id,
                    &payload.certificate_pem,
                )?;
                let nonce_base64 = challenge.nonce_base64();
                Ok(NativePipeRequestEvent::ChallengeIssued {
                    request_id,
                    challenge_id: challenge.challenge_id,
                    nonce_base64,
                })
            }
            CompanionRequestPayload::HandshakeProve(payload) => {
                let algorithm =
                    CompanionProofSignatureAlgorithm::parse(&payload.signature_algorithm)
                        .map_err(CertificateHandshakeError::Certificate)?;
                let runner = self.certificates.verify_pending_challenge(
                    &payload.challenge_id,
                    &payload.companion_instance_id,
                    &payload.nonce_base64,
                    &payload.signature_base64,
                    algorithm,
                );
                drop(admission);
                let runner = runner?;
                self.requests.accept_runner(runner.clone());
                Ok(NativePipeRequestEvent::Authenticated {
                    request_id,
                    runner_id: runner.runner_id,
                    certificate_sha256_fingerprint: runner.certificate_sha256_fingerprint,
                })
            }
            _ => Ok(NativePipeRequestEvent::ApplicationRequest(
                AdmittedNativeApplicationRequest {
                    request,
                    _admission: admission,
                },
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsPeerIdentity {
    pub pid: u32,
    pub token_user_sid: String,
    pub logon_sid: String,
    pub session_id: u32,
    pub image_path: String,
}

impl WindowsPeerIdentity {
    pub fn for_current_process() -> Result<Self, NativePipeError> {
        Self::for_pid(unsafe { GetCurrentProcessId() })
    }

    pub fn for_pid(pid: u32) -> Result<Self, NativePipeError> {
        let process = OwnedHandle::new(
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) },
            "OpenProcess",
        )?;
        let token = open_process_token(process.raw())?;
        let token_user_sid = token_user_sid_string(token.raw())?;
        let logon_sid = token_logon_sid_string(token.raw())?;
        let session_id = token_session_id(token.raw())?;
        let process_session_id = process_session_id(pid)?;
        if session_id != process_session_id {
            return Err(NativePipeError::CompanionIdentityRejected);
        }
        let image_path = canonical_process_image_path(process.raw())?;
        Ok(Self {
            pid,
            token_user_sid,
            logon_sid,
            session_id,
            image_path,
        })
    }
}

#[derive(Debug, Clone)]
pub enum BinarySignaturePolicy {
    /// Production mode: verify the image's embedded Authenticode signature and
    /// require one signer certificate SHA-1 thumbprint to match the canonical
    /// allowlist. Unsigned or untrusted images fail closed.
    RequireAuthenticodeSigner {
        allowed_sha1_thumbprints: HashSet<String>,
    },
    /// Native integration tests only. It still verifies PID/token/session/path;
    /// production callers must not use this policy.
    AllowUnsignedForNativeTestOnly,
}

#[derive(Debug, Clone)]
pub struct WindowsPeerPolicy {
    pub expected_logon_sid: String,
    pub expected_token_user_sid: String,
    pub expected_session_id: u32,
    pub allowed_image_paths: HashSet<String>,
    pub signature_policy: BinarySignaturePolicy,
}

impl WindowsPeerPolicy {
    pub fn for_current_process_test_only() -> Result<Self, NativePipeError> {
        let current = WindowsPeerIdentity::for_current_process()?;
        Ok(Self {
            expected_logon_sid: current.logon_sid,
            expected_token_user_sid: current.token_user_sid,
            expected_session_id: current.session_id,
            allowed_image_paths: [normalize_path_for_comparison(&current.image_path)]
                .into_iter()
                .collect(),
            signature_policy: BinarySignaturePolicy::AllowUnsignedForNativeTestOnly,
        })
    }
}

pub struct WindowsPeerAuthorizer {
    policy: WindowsPeerPolicy,
}

impl WindowsPeerAuthorizer {
    pub fn new(policy: WindowsPeerPolicy) -> Self {
        Self { policy }
    }

    pub fn authorize(&self, identity: &WindowsPeerIdentity) -> Result<(), NativePipeError> {
        if identity.logon_sid != self.policy.expected_logon_sid
            || identity.token_user_sid != self.policy.expected_token_user_sid
            || identity.session_id != self.policy.expected_session_id
        {
            return Err(NativePipeError::CompanionIdentityRejected);
        }
        if !self
            .policy
            .allowed_image_paths
            .contains(&normalize_path_for_comparison(&identity.image_path))
        {
            return Err(NativePipeError::CompanionIdentityRejected);
        }
        match &self.policy.signature_policy {
            BinarySignaturePolicy::AllowUnsignedForNativeTestOnly => Ok(()),
            BinarySignaturePolicy::RequireAuthenticodeSigner {
                allowed_sha1_thumbprints,
            } => require_authenticode_signer(&identity.image_path, allowed_sha1_thumbprints),
        }
    }
}

fn require_authenticode_signer(
    image_path: &str,
    allowed_sha1_thumbprints: &HashSet<String>,
) -> Result<(), NativePipeError> {
    if allowed_sha1_thumbprints.is_empty() {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let allowed: HashSet<String> = allowed_sha1_thumbprints
        .iter()
        .map(|thumbprint| normalize_thumbprint(thumbprint))
        .collect();
    let actual = authenticode_signer_thumbprints_sha1(image_path)?;
    if actual.iter().any(|thumbprint| allowed.contains(thumbprint)) {
        Ok(())
    } else {
        Err(NativePipeError::CompanionIdentityRejected)
    }
}

pub fn authenticode_signer_thumbprints_sha1(
    image_path: &str,
) -> Result<HashSet<String>, NativePipeError> {
    wintrust_signer_thumbprints_sha1(image_path)
        .or_else(|_| catalog_signer_thumbprints_sha1(image_path))
}

fn normalize_thumbprint(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace() && *ch != ':')
        .collect::<String>()
        .to_ascii_lowercase()
}

fn wintrust_signer_thumbprints_sha1(image_path: &str) -> Result<HashSet<String>, NativePipeError> {
    let mut trust = WinTrustVerification::verify(image_path)?;
    let provider = unsafe { WTHelperProvDataFromStateData(trust.state_handle()) };
    if provider.is_null() {
        return Err(NativePipeError::Win32 {
            operation: "WTHelperProvDataFromStateData",
            code: 0,
        });
    }
    let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
    if signer.is_null() {
        return Err(NativePipeError::Win32 {
            operation: "WTHelperGetProvSignerFromChain",
            code: 0,
        });
    }
    let cert = unsafe { WTHelperGetProvCertFromChain(signer, 0) };
    if cert.is_null() {
        return Err(NativePipeError::Win32 {
            operation: "WTHelperGetProvCertFromChain",
            code: 0,
        });
    }
    let cert_context = unsafe { (*cert).pCert };
    if cert_context.is_null() {
        return Err(NativePipeError::Win32 {
            operation: "WinTrustSignerCertContext",
            code: 0,
        });
    }
    let thumbprint = certificate_sha1_thumbprint(cert_context)?;
    Ok([thumbprint].into_iter().collect())
}

fn catalog_signer_thumbprints_sha1(image_path: &str) -> Result<HashSet<String>, NativePipeError> {
    let mut admin = 0isize;
    let hash_algorithm = wide("SHA256");
    let ok = unsafe {
        CryptCATAdminAcquireContext2(&mut admin, null(), hash_algorithm.as_ptr(), null(), 0)
    };
    if ok == 0 || admin == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let admin_guard = CatalogAdminGuard(admin);

    let wide_path = wide(image_path);
    let file = OwnedHandle::new(
        unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        },
        "CreateFileW",
    )?;

    let mut hash_len = 0u32;
    unsafe {
        CryptCATAdminCalcHashFromFileHandle2(admin, file.raw(), &mut hash_len, null_mut(), 0);
    }
    if hash_len == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let mut hash = vec![0u8; hash_len as usize];
    let ok = unsafe {
        CryptCATAdminCalcHashFromFileHandle2(admin, file.raw(), &mut hash_len, hash.as_mut_ptr(), 0)
    };
    if ok == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }

    let mut previous_catalog = 0isize;
    let catalog = unsafe {
        CryptCATAdminEnumCatalogFromHash(admin, hash.as_ptr(), hash_len, 0, &mut previous_catalog)
    };
    if catalog == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let _catalog_guard = CatalogContextGuard {
        admin: admin_guard.0,
        catalog,
    };

    let mut catalog_info = CATALOG_INFO {
        cbStruct: size_of::<CATALOG_INFO>() as u32,
        ..CATALOG_INFO::default()
    };
    let ok = unsafe { CryptCATCatalogInfoFromContext(catalog, &mut catalog_info, 0) };
    if ok == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }

    let member_tag = wide(&hex::encode(&hash));
    let mut catalog_info_for_trust = WINTRUST_CATALOG_INFO {
        cbStruct: size_of::<WINTRUST_CATALOG_INFO>() as u32,
        dwCatalogVersion: 0,
        pcwszCatalogFilePath: catalog_info.wszCatalogFile.as_ptr(),
        pcwszMemberTag: member_tag.as_ptr(),
        pcwszMemberFilePath: wide_path.as_ptr(),
        hMemberFile: file.raw(),
        pbCalculatedFileHash: hash.as_mut_ptr(),
        cbCalculatedFileHash: hash_len,
        pcCatalogContext: null_mut(),
        hCatAdmin: admin_guard.0,
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        pPolicyCallbackData: null_mut(),
        pSIPClientData: null_mut(),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_CATALOG,
        Anonymous: windows_sys::Win32::Security::WinTrust::WINTRUST_DATA_0 {
            pCatalog: &mut catalog_info_for_trust,
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: null_mut(),
        pwszURLReference: null_mut(),
        dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_DISABLE_MD2_MD4,
        dwUIContext: WTD_UICONTEXT_EXECUTE,
        pSignatureSettings: null_mut(),
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status =
        unsafe { WinVerifyTrust(null_mut(), &mut action, &mut data as *mut _ as *mut c_void) };
    let _state_guard = WinTrustStateGuard {
        h_state: data.hWVTStateData,
        action,
    };
    if status != 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let provider = unsafe { WTHelperProvDataFromStateData(data.hWVTStateData) };
    if provider.is_null() {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
    if signer.is_null() {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let cert = unsafe { WTHelperGetProvCertFromChain(signer, 0) };
    if cert.is_null() || unsafe { (*cert).pCert }.is_null() {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    Ok([certificate_sha1_thumbprint(unsafe { (*cert).pCert })?]
        .into_iter()
        .collect())
}

struct CatalogAdminGuard(isize);

impl Drop for CatalogAdminGuard {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CryptCATAdminReleaseContext(self.0, 0);
            }
        }
    }
}

struct CatalogContextGuard {
    admin: isize,
    catalog: isize,
}

impl Drop for CatalogContextGuard {
    fn drop(&mut self) {
        if self.admin != 0 && self.catalog != 0 {
            unsafe {
                CryptCATAdminReleaseCatalogContext(self.admin, self.catalog, 0);
            }
        }
    }
}

struct WinTrustStateGuard {
    h_state: HANDLE,
    action: windows_sys::core::GUID,
}

impl Drop for WinTrustStateGuard {
    fn drop(&mut self) {
        if !self.h_state.is_null() {
            let mut data = WINTRUST_DATA {
                cbStruct: size_of::<WINTRUST_DATA>() as u32,
                dwStateAction: WTD_STATEACTION_CLOSE,
                hWVTStateData: self.h_state,
                ..WINTRUST_DATA::default()
            };
            unsafe {
                WinVerifyTrust(
                    null_mut(),
                    &mut self.action,
                    &mut data as *mut _ as *mut c_void,
                );
            }
        }
    }
}

struct WinTrustVerification {
    data: WINTRUST_DATA,
    action: windows_sys::core::GUID,
    _file_info: Box<WINTRUST_FILE_INFO>,
    _wide_path: Vec<u16>,
}

impl WinTrustVerification {
    fn verify(image_path: &str) -> Result<Self, NativePipeError> {
        let wide_path = wide(image_path);
        let mut file_info = Box::new(WINTRUST_FILE_INFO {
            cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: wide_path.as_ptr(),
            hFile: null_mut(),
            pgKnownSubject: null_mut(),
        });
        let mut data = WINTRUST_DATA {
            cbStruct: size_of::<WINTRUST_DATA>() as u32,
            pPolicyCallbackData: null_mut(),
            pSIPClientData: null_mut(),
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: windows_sys::Win32::Security::WinTrust::WINTRUST_DATA_0 {
                pFile: file_info.as_mut(),
            },
            dwStateAction: WTD_STATEACTION_VERIFY,
            hWVTStateData: null_mut(),
            pwszURLReference: null_mut(),
            dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_DISABLE_MD2_MD4,
            dwUIContext: WTD_UICONTEXT_EXECUTE,
            pSignatureSettings: null_mut(),
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let status =
            unsafe { WinVerifyTrust(null_mut(), &mut action, &mut data as *mut _ as *mut c_void) };
        if status == 0 {
            Ok(Self {
                data,
                action,
                _file_info: file_info,
                _wide_path: wide_path,
            })
        } else {
            Err(NativePipeError::Win32 {
                operation: "WinVerifyTrust",
                code: status as u32,
            })
        }
    }

    fn state_handle(&mut self) -> HANDLE {
        self.data.hWVTStateData
    }
}

impl Drop for WinTrustVerification {
    fn drop(&mut self) {
        if !self.data.hWVTStateData.is_null() {
            self.data.dwStateAction = WTD_STATEACTION_CLOSE;
            unsafe {
                WinVerifyTrust(
                    null_mut(),
                    &mut self.action,
                    &mut self.data as *mut _ as *mut c_void,
                );
            }
        }
    }
}

#[allow(dead_code)]
fn signer_thumbprints_from_embedded_signature(
    image_path: &str,
) -> Result<HashSet<String>, NativePipeError> {
    let wide_path = wide(image_path);
    let mut encoding: CERT_QUERY_ENCODING_TYPE = 0;
    let mut content: CERT_QUERY_CONTENT_TYPE = 0;
    let mut format: CERT_QUERY_FORMAT_TYPE = 0;
    let mut store = null_mut();
    let mut message = null_mut();
    let ok = unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            wide_path.as_ptr() as *const c_void,
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            &mut encoding,
            &mut content,
            &mut format,
            &mut store,
            &mut message,
            null_mut(),
        )
    };
    if ok == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let _store_guard = CertificateStoreGuard(store);
    let _message_guard = CryptMessageGuard(message);

    let mut count_size = size_of::<u32>() as u32;
    let mut signer_count = 0u32;
    let ok = unsafe {
        CryptMsgGetParam(
            message,
            CMSG_SIGNER_COUNT_PARAM,
            0,
            &mut signer_count as *mut _ as *mut c_void,
            &mut count_size,
        )
    };
    if ok == 0 || signer_count == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }

    let mut thumbprints = HashSet::new();
    for index in 0..signer_count {
        let signer = signer_info(message, index)?;
        let mut cert_info = CERT_INFO::default();
        cert_info.Issuer = signer.Issuer;
        cert_info.SerialNumber = signer.SerialNumber;
        let cert = unsafe {
            CertFindCertificateInStore(
                store,
                encoding,
                0,
                CERT_FIND_SUBJECT_CERT,
                &cert_info as *const _ as *const c_void,
                null(),
            )
        };
        if cert.is_null() {
            continue;
        }
        let _cert_guard = CertificateContextGuard(cert);
        thumbprints.insert(certificate_sha1_thumbprint(cert)?);
    }

    if thumbprints.is_empty() {
        Err(NativePipeError::CompanionIdentityRejected)
    } else {
        Ok(thumbprints)
    }
}

#[allow(dead_code)]
fn signer_info(message: *mut c_void, index: u32) -> Result<CMSG_SIGNER_INFO, NativePipeError> {
    let mut size = 0u32;
    let ok = unsafe {
        CryptMsgGetParam(
            message,
            CMSG_SIGNER_INFO_PARAM,
            index,
            null_mut(),
            &mut size,
        )
    };
    if ok == 0 || size < size_of::<CMSG_SIGNER_INFO>() as u32 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let mut buffer = vec![0u8; size as usize];
    let ok = unsafe {
        CryptMsgGetParam(
            message,
            CMSG_SIGNER_INFO_PARAM,
            index,
            buffer.as_mut_ptr() as *mut c_void,
            &mut size,
        )
    };
    if ok == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    Ok(unsafe { *(buffer.as_ptr() as *const CMSG_SIGNER_INFO) })
}

fn certificate_sha1_thumbprint(cert: *const CERT_CONTEXT) -> Result<String, NativePipeError> {
    let mut size = 0u32;
    let ok = unsafe {
        CertGetCertificateContextProperty(cert, CERT_SHA1_HASH_PROP_ID, null_mut(), &mut size)
    };
    if ok == 0 || size == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    let mut buffer = vec![0u8; size as usize];
    let ok = unsafe {
        CertGetCertificateContextProperty(
            cert,
            CERT_SHA1_HASH_PROP_ID,
            buffer.as_mut_ptr() as *mut c_void,
            &mut size,
        )
    };
    if ok == 0 {
        return Err(NativePipeError::CompanionIdentityRejected);
    }
    Ok(hex::encode(buffer))
}

#[allow(dead_code)]
struct CertificateStoreGuard(windows_sys::Win32::Security::Cryptography::HCERTSTORE);

impl Drop for CertificateStoreGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CertCloseStore(self.0, 0);
            }
        }
    }
}

#[allow(dead_code)]
struct CryptMessageGuard(*mut c_void);

impl Drop for CryptMessageGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CryptMsgClose(self.0);
            }
        }
    }
}

#[allow(dead_code)]
struct CertificateContextGuard(*const CERT_CONTEXT);

impl Drop for CertificateContextGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CertFreeCertificateContext(self.0);
            }
        }
    }
}

pub fn pipe_dacl_sddl_for_logon_sid(logon_sid: &str) -> String {
    format!("D:P(A;;GA;;;SY)(A;;GA;;;{logon_sid})")
}

pub fn pipe_path_for_logon_sid(prefix: &str, logon_sid: &str) -> Result<String, NativePipeError> {
    if prefix.is_empty()
        || prefix.contains('\\')
        || prefix.contains('/')
        || logon_sid.is_empty()
        || logon_sid.contains('\\')
        || logon_sid.contains('/')
    {
        return Err(NativePipeError::InvalidPipeName);
    }
    Ok(format!(r"\\.\pipe\{prefix}-{logon_sid}"))
}

pub fn assert_windows_11_or_newer() -> Result<(), NativePipeError> {
    let mut version: OSVERSIONINFOW = unsafe { zeroed() };
    version.dwOSVersionInfoSize = size_of::<OSVERSIONINFOW>() as u32;
    let status = unsafe { RtlGetVersion(&mut version) };
    if status < 0 || version.dwMajorVersion < 10 || version.dwBuildNumber < 22_000 {
        return Err(NativePipeError::Windows11Unavailable);
    }
    Ok(())
}

pub fn current_logon_sid_string() -> Result<String, NativePipeError> {
    let token = open_process_token(unsafe { GetCurrentProcess() })?;
    token_logon_sid_string(token.raw())
}

pub fn current_user_sid_string() -> Result<String, NativePipeError> {
    let token = open_process_token(unsafe { GetCurrentProcess() })?;
    token_user_sid_string(token.raw())
}

pub fn current_session_id() -> Result<u32, NativePipeError> {
    process_session_id(unsafe { GetCurrentProcessId() })
}

pub fn connect_client_for_test(path: &str) -> Result<OwnedHandle, NativePipeError> {
    let wide_path = wide(path);
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    OwnedHandle::new(handle, "CreateFileW")
}

pub fn normalize_path_for_comparison(path: &str) -> String {
    let canonical = std::fs::canonicalize(Path::new(path)).unwrap_or_else(|_| PathBuf::from(path));
    canonical
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', "\\")
        .to_ascii_lowercase()
}

struct SecurityDescriptor(*mut c_void);

impl SecurityDescriptor {
    fn for_logon_sid(logon_sid: &str) -> Result<Self, NativePipeError> {
        let sddl = pipe_dacl_sddl_for_logon_sid(logon_sid);
        let mut descriptor: *mut c_void = null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&sddl).as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
        Ok(Self(descriptor))
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.0
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

#[derive(Debug)]
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE, operation: &'static str) -> Result<Self, NativePipeError> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(last_error(operation));
        }
        Ok(Self(handle))
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub struct BorrowedPipeConnection<'a> {
    handle: HANDLE,
    _owner: PhantomData<&'a NamedPipeListener>,
}

impl Read for BorrowedPipeConnection<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        pipe_read_overlapped(self.handle, buf)
    }
}

impl Write for BorrowedPipeConnection<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        pipe_write_overlapped(self.handle, buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for OwnedHandle {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        pipe_read_blocking(self.0, buf)
    }
}

impl Write for OwnedHandle {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        pipe_write_blocking(self.0, buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn pipe_read_blocking(handle: HANDLE, buf: &mut [u8]) -> io::Result<usize> {
    let len = buf.len().min(u32::MAX as usize) as u32;
    let mut transferred = 0u32;
    let ok = unsafe { ReadFile(handle, buf.as_mut_ptr(), len, &mut transferred, null_mut()) };
    if ok == 0 {
        Err(io_error_from_last())
    } else {
        Ok(transferred as usize)
    }
}

fn pipe_write_blocking(handle: HANDLE, buf: &[u8]) -> io::Result<usize> {
    let len = buf.len().min(u32::MAX as usize) as u32;
    let mut transferred = 0u32;
    let ok = unsafe { WriteFile(handle, buf.as_ptr(), len, &mut transferred, null_mut()) };
    if ok == 0 {
        Err(io_error_from_last())
    } else {
        Ok(transferred as usize)
    }
}

fn pipe_read_overlapped(handle: HANDLE, buf: &mut [u8]) -> io::Result<usize> {
    let len = buf.len().min(u32::MAX as usize) as u32;
    let mut transferred = 0u32;
    let event = io_event()?;
    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    overlapped.hEvent = event.raw();
    let ok = unsafe {
        ReadFile(
            handle,
            buf.as_mut_ptr(),
            len,
            &mut transferred,
            &mut overlapped,
        )
    };
    complete_overlapped(handle, ok, &mut overlapped, transferred)
}

fn pipe_write_overlapped(handle: HANDLE, buf: &[u8]) -> io::Result<usize> {
    let len = buf.len().min(u32::MAX as usize) as u32;
    let mut transferred = 0u32;
    let event = io_event()?;
    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    overlapped.hEvent = event.raw();
    let ok = unsafe { WriteFile(handle, buf.as_ptr(), len, &mut transferred, &mut overlapped) };
    complete_overlapped(handle, ok, &mut overlapped, transferred)
}

fn complete_overlapped(
    handle: HANDLE,
    ok: i32,
    overlapped: &mut OVERLAPPED,
    immediate_transferred: u32,
) -> io::Result<usize> {
    if ok != 0 {
        return Ok(immediate_transferred as usize);
    }
    let code = unsafe { GetLastError() };
    if code != ERROR_IO_PENDING {
        return Err(io_error_from_code(code));
    }
    let wait = unsafe { WaitForSingleObject(overlapped.hEvent, 5_000) };
    if wait != WAIT_OBJECT_0 {
        unsafe {
            CancelIoEx(handle, overlapped);
        }
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "pipe I/O timed out",
        ));
    }
    let mut transferred = 0u32;
    let ok = unsafe { GetOverlappedResult(handle, overlapped, &mut transferred, 0) };
    if ok == 0 {
        Err(io_error_from_last())
    } else {
        Ok(transferred as usize)
    }
}

fn io_event() -> io::Result<OwnedHandle> {
    OwnedHandle::new(
        unsafe { CreateEventW(null(), 1, 0, null()) },
        "CreateEventW",
    )
    .map_err(|error| io::Error::new(io::ErrorKind::Other, error))
}

fn io_error_from_last() -> io::Error {
    io_error_from_code(unsafe { GetLastError() })
}

fn io_error_from_code(code: u32) -> io::Error {
    if code == ERROR_BROKEN_PIPE {
        io::Error::new(io::ErrorKind::UnexpectedEof, "named pipe peer disconnected")
    } else {
        io::Error::from_raw_os_error(code as i32)
    }
}

fn open_process_token(process: HANDLE) -> Result<OwnedHandle, NativePipeError> {
    let mut token = null_mut();
    let ok = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
    if ok == 0 {
        return Err(last_error("OpenProcessToken"));
    }
    Ok(OwnedHandle(token))
}

fn token_user_sid_string(token: HANDLE) -> Result<String, NativePipeError> {
    let data = token_information(token, TokenUser)?;
    let token_user = unsafe { &*(data.as_ptr() as *const TOKEN_USER) };
    sid_to_string(token_user.User.Sid)
}

fn token_logon_sid_string(token: HANDLE) -> Result<String, NativePipeError> {
    let data = token_information(token, TokenGroups)?;
    let groups = unsafe { &*(data.as_ptr() as *const TOKEN_GROUPS) };
    let count = groups.GroupCount as usize;
    let first = groups.Groups.as_ptr();
    for index in 0..count {
        let group = unsafe { *first.add(index) };
        let logon_attr = SE_GROUP_LOGON_ID as u32;
        if group.Attributes & logon_attr == logon_attr {
            return sid_to_string(group.Sid);
        }
    }
    Err(NativePipeError::CompanionIdentityRejected)
}

fn token_session_id(token: HANDLE) -> Result<u32, NativePipeError> {
    let data = token_information(token, TokenSessionId)?;
    let value = unsafe { *(data.as_ptr() as *const u32) };
    Ok(value)
}

fn token_information(token: HANDLE, class: i32) -> Result<Vec<u8>, NativePipeError> {
    let mut needed = 0u32;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(last_error("GetTokenInformation(size)"));
    }
    let mut data = vec![0u8; needed as usize];
    let ok = unsafe {
        GetTokenInformation(
            token,
            class,
            data.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(last_error("GetTokenInformation"));
    }
    Ok(data)
}

fn sid_to_string(sid: *mut c_void) -> Result<String, NativePipeError> {
    let mut raw = null_mut();
    let ok = unsafe { ConvertSidToStringSidW(sid, &mut raw) };
    if ok == 0 {
        return Err(last_error("ConvertSidToStringSidW"));
    }
    let result = unsafe { wide_ptr_to_string(raw) };
    unsafe {
        LocalFree(raw as *mut c_void);
    }
    Ok(result)
}

fn process_session_id(pid: u32) -> Result<u32, NativePipeError> {
    let mut session_id = 0u32;
    let ok = unsafe { ProcessIdToSessionId(pid, &mut session_id) };
    if ok == 0 {
        return Err(last_error("ProcessIdToSessionId"));
    }
    Ok(session_id)
}

fn canonical_process_image_path(process: HANDLE) -> Result<String, NativePipeError> {
    let mut chars = 32768u32;
    let mut buffer = vec![0u16; chars as usize];
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut chars) };
    if ok == 0 {
        return Err(last_error("QueryFullProcessImageNameW"));
    }
    buffer.truncate(chars as usize);
    Ok(String::from_utf16_lossy(&buffer))
}

unsafe fn wide_ptr_to_string(ptr: *const u16) -> String {
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(once(0)).collect()
}

fn last_error(operation: &'static str) -> NativePipeError {
    NativePipeError::Win32 {
        operation,
        code: unsafe { GetLastError() },
    }
}
