//! Action risk classification, mirrored from the TypeScript `LocalActionRisk`
//! contract. The Companion's approval policy is driven entirely by this value:
//! `ProductionForbidden` is never issued, `Normal` may be auto-issued inside an
//! active unpaused session, and everything else requires explicit human
//! approval before a Permit is minted.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Risk {
    Normal,
    ExternalSideEffect,
    Destructive,
    ProductionForbidden,
}

/// How the approval policy treats a given risk class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskPolicy {
    /// May be auto-issued without a human prompt in an active unpaused session.
    AutoNormal,
    /// Requires an explicit human approval before any Permit is minted.
    RequiresApproval,
    /// Never authorized under any circumstances.
    Forbidden,
}

impl Risk {
    pub fn policy(self) -> RiskPolicy {
        match self {
            Risk::Normal => RiskPolicy::AutoNormal,
            Risk::ExternalSideEffect | Risk::Destructive => RiskPolicy::RequiresApproval,
            Risk::ProductionForbidden => RiskPolicy::Forbidden,
        }
    }
}
