//! A cart.

use std::fmt;

pub const MAX: usize = 99;
pub static NAME: &str = "cart";
const _: () = ();

pub type Id = u32;

macro_rules! twice {
    ($x:expr) => {
        $x * 2
    };
}

pub struct Item {
    pub id: Id,
    pub price: u32,
}

pub struct Cart {
    items: Vec<Item>,
    owner: String,
}

pub struct Marker;

pub enum Kind {
    Plain,
    Bulk(u32),
    Named { size: u32 },
}

pub trait Total {
    const BASE: u32;
    type Out;
    fn total(&self) -> u32;
    fn label(&self) -> String {
        String::from("total")
    }
}

impl Cart {
    pub fn add(&mut self, item: Item) {
        if self.items.len() < MAX {
            self.items.push(item);
        }
    }

    pub fn reset(
        &mut self,
        keep: usize,
    ) {
        self.items.truncate(keep);
    }
}

impl Total for Cart {
    const BASE: u32 = 0;
    type Out = u32;

    fn total(&self) -> u32 {
        self.items.iter().map(|item| item.price).sum()
    }
}

impl<T: fmt::Debug> fmt::Debug for Wrapper<T> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "w")
    }
}

pub mod inner {
    pub fn helper() -> u32 {
        twice!(2)
    }
}

pub fn build(owner: &str) -> Cart {
    Cart { items: Vec::new(), owner: owner.to_string() }
}
