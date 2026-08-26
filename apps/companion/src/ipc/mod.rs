//! Companion IPC: the authenticated, bounded, typed transport surface.

pub mod dto;
pub mod security;
pub mod server;
#[cfg(windows)]
pub mod windows_pipe;
