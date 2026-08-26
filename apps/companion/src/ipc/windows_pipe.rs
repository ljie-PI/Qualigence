//! Native Windows Named Pipe authority for the Companion.
//!
//! This module contains the Win32 boundary for Ticket 29. It deliberately has no
//! portable fallback: on non-Windows builds the module is not compiled, and the
//! native tests fail with `Windows11Unavailable` rather than claiming coverage.

#![cfg(windows)]

use std::collections::HashSet;
use std::ffi::c_void;
use std::fmt;
use std::iter::once;
use std::mem::{size_of, zeroed};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_IO_PENDING, ERROR_PIPE_BUSY,
    ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenGroups, TokenSessionId, TokenUser, SECURITY_ATTRIBUTES, TOKEN_GROUPS,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX,
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
use windows_sys::Win32::System::IO::{CancelIoEx, OVERLAPPED};

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
    /// Production mode: this module refuses to accept unsigned images. The
    /// authenticode signer extraction is intentionally an explicit policy seam;
    /// tests use `AllowUnsignedForNativeTestOnly` because development Rust test
    /// binaries are not Authenticode-signed.
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
            } => {
                if allowed_sha1_thumbprints.is_empty() {
                    return Err(NativePipeError::CompanionIdentityRejected);
                }
                // The caller supplied a production signing policy, but this
                // Ticket 29 seam currently requires an allowlisted signer
                // thumbprint provider to be wired by the daemon. Failing closed
                // is safer than accepting an unsigned or unverified process.
                Err(NativePipeError::UnsupportedSignaturePolicy)
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
