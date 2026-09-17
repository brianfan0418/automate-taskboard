//! Amendment 14 (2.0.2): the board service tree dies with the launcher.
//!
//! Installing 2.0.1 over 2.0.0 failed because the launcher had exited while its node service (and
//! the `codex-runtime\codex.exe` it started) kept running and held `node.exe` open. The launcher now
//! keeps the service processes in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: when the
//! launcher exits for any reason the kernel closes the job handle and kills them.
//!
//! The job also sets `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so processes started by a job member are
//! NOT added automatically. That keeps processes that must outlive the board out of the job — for
//! example the Claude background daemon that `claude --bg` cold-starts, which runs every Claude
//! background session. Instead the launcher adopts, once a second, only the descendants of the
//! service child whose executable lives in the launcher's install directory (`node.exe`) or in
//! `%APPDATA%\AutoMate Taskboard\codex-runtime` (`codex.exe`) — the files an installer must replace.

use std::{
    ffi::c_void,
    mem::size_of,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use windows::{
    core::{BOOL, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
                JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
            },
            Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
            },
        },
    },
};

pub struct ServiceJob {
    handle: HANDLE,
}

// The handle is only used through thread-safe kernel calls.
unsafe impl Send for ServiceJob {}
unsafe impl Sync for ServiceJob {}

impl ServiceJob {
    pub fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|error| format!("CreateJobObject: {error}"))?;
        let job = Self { handle };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|error| format!("SetInformationJobObject: {error}"))?;
        Ok(job)
    }

    /// Adds a running process to the job. `Ok(false)` when it already belongs to this job.
    pub fn assign(&self, pid: u32) -> Result<bool, String> {
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
        }
        .map_err(|error| format!("OpenProcess {pid}: {error}"))?;
        let mut in_job = BOOL(0);
        let result = unsafe { IsProcessInJob(process, Some(self.handle), &mut in_job) }
            .map_err(|error| format!("IsProcessInJob {pid}: {error}"))
            .and_then(|_| {
                if in_job.as_bool() {
                    return Ok(false);
                }
                unsafe { AssignProcessToJobObject(self.handle, process) }
                    .map(|_| true)
                    .map_err(|error| format!("AssignProcessToJobObject {pid}: {error}"))
            });
        let _ = unsafe { CloseHandle(process) };
        result
    }

    pub fn active_processes(&self) -> u32 {
        let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                Some(self.handle),
                JobObjectBasicAccountingInformation,
                &mut information as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        };
        if queried.is_err() {
            return 0;
        }
        information.ActiveProcesses
    }

    /// Process IDs currently in the job.
    pub fn process_ids(&self) -> Vec<u32> {
        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two u32 counts, then a usize array.
        const CAPACITY: usize = 512;
        let mut buffer = vec![0usize; 1 + CAPACITY];
        let queried = unsafe {
            QueryInformationJobObject(
                Some(self.handle),
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr() as *mut c_void,
                (buffer.len() * size_of::<usize>()) as u32,
                None,
            )
        };
        if queried.is_err() {
            return Vec::new();
        }
        let listed = (buffer[0] >> 32) as usize;
        buffer[1..=listed.min(CAPACITY)]
            .iter()
            .map(|pid| *pid as u32)
            .collect()
    }

    /// Adopts every descendant of `root_pid` (or of a process already in the job) whose executable is
    /// under one of `roots`. Returns the newly adopted process IDs.
    pub fn adopt_owned_descendants(&self, root_pid: u32, roots: &[PathBuf]) -> Vec<u32> {
        let mut seeds = self.process_ids();
        seeds.push(root_pid);
        let mut adopted = Vec::new();
        // A parent PID can be reused: an edge only counts when the parent started before the child.
        let valid_edge = |parent: u32, child: u32| match (process_start_time(parent), process_start_time(child)) {
            (Some(parent_start), Some(child_start)) => parent_start <= child_start,
            _ => false,
        };
        for pid in descendants(&seeds, &process_parent_pairs(), valid_edge) {
            let Some(image) = process_image_path(pid) else {
                continue;
            };
            if !path_is_under_any(&image, roots) {
                continue;
            }
            if let Ok(true) = self.assign(pid) {
                adopted.push(pid);
            }
        }
        adopted
    }

    /// Kills every process in the job and waits until none is left (or `timeout`).
    pub fn terminate_and_wait(&self, timeout: Duration) -> bool {
        if self.active_processes() == 0 {
            return true;
        }
        let _ = unsafe { TerminateJobObject(self.handle, 1) };
        let deadline = Instant::now() + timeout;
        while self.active_processes() > 0 {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        true
    }
}

impl Drop for ServiceJob {
    fn drop(&mut self) {
        // With JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE this kills whatever is still in the job.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

fn process_parent_pairs() -> Vec<(u32, u32)> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let mut pairs = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };
    pairs
}

/// Process creation time (100 ns ticks since 1601), None when the process cannot be opened.
fn process_start_time(pid: u32) -> Option<u64> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let queried =
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
    let _ = unsafe { CloseHandle(process) };
    queried.ok()?;
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

fn process_image_path(pid: u32) -> Option<PathBuf> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    let queried = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    let _ = unsafe { CloseHandle(process) };
    queried.ok()?;
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])))
}

/// Every process reachable from `seeds` through parent links (the seeds themselves excluded unless
/// another seed is their ancestor). `pairs` = (pid, parent pid); `valid_edge(parent, child)` rejects
/// links through a reused parent PID.
pub fn descendants(
    seeds: &[u32],
    pairs: &[(u32, u32)],
    valid_edge: impl Fn(u32, u32) -> bool,
) -> Vec<u32> {
    let mut found: Vec<u32> = Vec::new();
    let mut frontier: Vec<u32> = seeds.to_vec();
    while let Some(parent) = frontier.pop() {
        for (pid, parent_pid) in pairs {
            if *parent_pid == parent
                && *pid != parent
                && *pid != 0
                && !found.contains(pid)
                && valid_edge(parent, *pid)
            {
                found.push(*pid);
                frontier.push(*pid);
            }
        }
    }
    found
}

/// Case-insensitive path prefix test on whole components (`C:\A\B` is not under `C:\A\Bc`).
pub fn path_is_under_any(path: &Path, roots: &[PathBuf]) -> bool {
    let normalize = |value: &Path| {
        value
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', r"\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let candidate = normalize(path);
    roots.iter().any(|root| {
        let root = normalize(root);
        !root.is_empty() && candidate.len() > root.len() && candidate.starts_with(&root)
            && candidate.as_bytes()[root.len()] == b'\\'
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    #[test]
    fn descendants_follow_parent_links_from_every_seed() {
        let pairs = [(10, 1), (11, 10), (12, 11), (20, 1), (21, 20), (30, 99), (31, 30)];
        let mut found = descendants(&[10, 30], &pairs, |_, _| true);
        found.sort();
        assert_eq!(found, vec![11, 12, 31]);
        assert!(descendants(&[42], &pairs, |_, _| true).is_empty());
    }

    #[test]
    fn a_child_older_than_its_parent_pid_is_an_orphan_of_a_reused_pid() {
        // 11 was started (t=5) before the current process 10 (t=7) reused its dead parent's PID.
        let start = |pid: u32| match pid {
            10 => 7,
            11 => 5,
            12 => 9,
            _ => 0,
        };
        let pairs = [(10, 1), (11, 10), (12, 10)];
        let found = descendants(&[10], &pairs, |parent, child| start(parent) <= start(child));
        assert_eq!(found, vec![12]);
    }

    #[test]
    fn owned_paths_match_whole_components_case_insensitively() {
        let roots = [
            PathBuf::from(r"C:\Users\me\AppData\Local\AutoMate Taskboard"),
            PathBuf::from(r"C:\Users\me\AppData\Roaming\AutoMate Taskboard\codex-runtime\"),
        ];
        assert!(path_is_under_any(
            Path::new(r"c:\users\me\appdata\local\automate taskboard\node.exe"),
            &roots
        ));
        assert!(path_is_under_any(
            Path::new(r"\\?\C:\Users\me\AppData\Roaming\AutoMate Taskboard\codex-runtime\0.1\codex.exe"),
            &roots
        ));
        assert!(!path_is_under_any(
            Path::new(r"C:\Users\me\AppData\Local\AutoMate Taskboard2\node.exe"),
            &roots
        ));
        assert!(!path_is_under_any(
            Path::new(r"C:\Users\me\AppData\Roaming\Claude\claude-code\2.1.271\claude.exe"),
            &roots
        ));
        assert!(!path_is_under_any(Path::new(r"C:\Users\me\AppData\Local\AutoMate Taskboard"), &roots));
    }

    fn sleeping_child() -> std::process::Child {
        Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 60 127.0.0.1 >nul"])
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test child")
    }

    fn exits_within(child: &mut std::process::Child, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if child.try_wait().expect("try_wait").is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn closing_the_job_kills_its_processes() {
        let job = ServiceJob::new().expect("job");
        let mut child = sleeping_child();
        assert_eq!(job.assign(child.id()), Ok(true));
        assert_eq!(job.assign(child.id()), Ok(false));
        assert!(job.process_ids().contains(&child.id()));
        assert!(job.active_processes() >= 1);
        drop(job);
        assert!(exits_within(&mut child, Duration::from_secs(10)));
    }

    #[test]
    fn terminate_and_wait_empties_the_job_and_children_of_members_are_not_added() {
        let job = ServiceJob::new().expect("job");
        let mut child = sleeping_child();
        job.assign(child.id()).expect("assign");
        // cmd.exe starts ping.exe; with silent breakaway it stays outside the job until adopted.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut ping = None;
        while ping.is_none() && Instant::now() < deadline {
            ping = descendants(&[child.id()], &process_parent_pairs(), |_, _| true)
                .into_iter()
                .next();
            std::thread::sleep(Duration::from_millis(50));
        }
        let ping = ping.expect("ping.exe started");
        assert!(!job.process_ids().contains(&ping));
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).expect("SystemRoot");
        let adopted = job.adopt_owned_descendants(child.id(), &[system]);
        assert!(adopted.contains(&ping));
        assert!(job.terminate_and_wait(Duration::from_secs(10)));
        assert_eq!(job.active_processes(), 0);
        assert!(exits_within(&mut child, Duration::from_secs(10)));
    }
}
