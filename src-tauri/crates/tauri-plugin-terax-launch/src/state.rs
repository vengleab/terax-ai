use std::sync::Mutex;

/// Folders waiting for the frontend. Drained on read, so a reload cannot replay them.
#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

impl Pending {
    pub fn push(&self, folders: Vec<String>) {
        let mut pending = self.lock();
        for folder in folders {
            if !pending.contains(&folder) {
                pending.push(folder);
            }
        }
    }

    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.lock())
    }

    // A poisoned lock only means another thread panicked mid-push; the list itself is still valid.
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_returns_everything_once() {
        let pending = Pending::default();
        pending.push(vec!["/a".into(), "/b".into()]);
        assert_eq!(pending.take(), vec!["/a".to_string(), "/b".to_string()]);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn the_same_folder_is_not_queued_twice() {
        let pending = Pending::default();
        pending.push(vec!["/a".into()]);
        pending.push(vec!["/a".into(), "/b".into()]);
        assert_eq!(pending.take(), vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn a_poisoned_lock_does_not_lose_the_list() {
        let pending = std::sync::Arc::new(Pending::default());
        pending.push(vec!["/a".into()]);
        let clone = pending.clone();
        let _ = std::thread::spawn(move || {
            let _guard = clone.0.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert_eq!(pending.take(), vec!["/a".to_string()]);
    }
}
