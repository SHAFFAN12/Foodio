
/* ===================SHOW MENU=============== */

 const navMenu = document.getElementById('nav-menu'),
 navToggle = document.getElementById('nav-toggle'),
 navClose = document.getElementById('nav-close');


/* =======MENU SHOW============ */

// Validate if constant exists

 if (navToggle) {
   navToggle.addEventListener('click', () => {
    navMenu.classList.add('show-menu');
   });
}


/* =======MENU HIDDEN============ */

// Validate if constant exists

 if (navClose) {
   navClose.addEventListener('click', () => {
     navMenu.classList.remove('show-menu');
   });
 }

// HOME SWIPER
var homeSwiper = new Swiper(".home-swiper", {
    spaceBetween:30,
    loop:'true',
    pagination: {
      el: ".swiper-pagination",
      clickable: true ,
    },

    navigation: {
        nextEl: ".swiper-button-next",
        prevEl: ".swiper-button-prev",
      },
  });

  // =================DEALS TAB==============

  const tabs = document.querySelectorAll('[data-target]'),
  tabContent = document.querySelectorAll('[content]');

  tabs.forEach((tab) => {
    tab.addEventListener(('click'), () => {
      const target = document.querySelector(tab.dataset.target);
      tabContent.forEach((tabContent) => {
        tabContent.classList.remove('active-tab');
      });
      target.classList.add('active-tab');

      tabs.forEach((tab) => {
        tab.classList.remove('active-tab');
      });
      tab.classList.add('active-tab');
    });
  });


  /* =============Show Scroll Up==========*/

  function scrollUp(){
    const scrollUp = document.getElementById('scroll-up')

    if(this.scrollY>=350) scrollUp.classList.add('show-scroll');
    else scrollUp.classList.remove('show-scroll');
  }

  window.addEventListener('scroll',scrollUp )

  /* =============RESERVATION FORM==========*/
  const reservationForm = document.querySelector('.reservation__form');
  if (reservationForm) {
    reservationForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const inputs = reservationForm.querySelectorAll('.reservation__form-input');
      const reservationData = {
        guests: inputs[0].value,
        name: inputs[1].value,
        phone: inputs[2].value,
        email: inputs[3].value,
        date: inputs[4].value,
        time: inputs[5].value,
      };

      fetch('https://foodio-backend.vercel.app/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reservationData),
      })
      .then(response => response.json())
      .then(data => {
        alert(data.message);
        reservationForm.reset();
      })
      .catch((error) => {
        console.error('Error:', error);
        alert('There was an error with your reservation. Please try again.');
      });
    });
  }
