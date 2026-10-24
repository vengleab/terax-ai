use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// Coalesces bursts of events per key: only the last event in a burst acts.
#[derive(Default)]
pub struct Debouncer {
    generations: Mutex<HashMap<String, u64>>,
}

impl Debouncer {
    pub fn bump(&self, key: &str) -> u64 {
        let Ok(mut map) = self.generations.lock() else {
            return 0;
        };
        let next = map.get(key).copied().unwrap_or(0) + 1;
        map.insert(key.to_string(), next);
        next
    }

    pub fn is_current(&self, key: &str, generation: u64) -> bool {
        self.generations
            .lock()
            .map(|map| map.get(key).copied() == Some(generation))
            .unwrap_or(false)
    }

    pub fn finish(&self, key: &str, generation: u64) {
        if let Ok(mut map) = self.generations.lock() {
            if map.get(key).copied() == Some(generation) {
                map.remove(key);
            }
        }
    }

    /// Waits `delay` and reports whether this call is still the latest for `key`.
    pub async fn settle(&self, key: &str, delay: Duration) -> Option<u64> {
        let generation = self.bump(key);
        tokio::time::sleep(delay).await;
        self.is_current(key, generation).then_some(generation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test(start_paused = true)]
    async fn only_the_last_event_of_a_burst_settles() {
        let debouncer = Arc::new(Debouncer::default());
        let delay = Duration::from_millis(300);
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let d = debouncer.clone();
            tasks.push(tokio::spawn(async move { d.settle("file", delay).await }));
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let mut settled = 0;
        for task in tasks {
            if task.await.unwrap().is_some() {
                settled += 1;
            }
        }
        assert_eq!(settled, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn different_keys_do_not_interfere() {
        let debouncer = Arc::new(Debouncer::default());
        let a = {
            let d = debouncer.clone();
            tokio::spawn(async move { d.settle("a", Duration::from_millis(100)).await })
        };
        let b = {
            let d = debouncer.clone();
            tokio::spawn(async move { d.settle("b", Duration::from_millis(100)).await })
        };
        assert!(a.await.unwrap().is_some());
        assert!(b.await.unwrap().is_some());
    }

    #[test]
    fn finish_only_clears_the_current_generation() {
        let debouncer = Debouncer::default();
        let first = debouncer.bump("k");
        let second = debouncer.bump("k");
        debouncer.finish("k", first);
        assert!(debouncer.is_current("k", second));
        debouncer.finish("k", second);
        assert!(!debouncer.is_current("k", second));
    }
}
